import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PdfIngestError } from './errors'
import { buildRows } from './rows'
import type { PdfPage, PdfTextDocument, TextItem } from './types'

export interface PdfAssets {
  workerSrc: string
  standardFontDataUrl: string
  cMapUrl: string
  iccUrl: string
  wasmUrl: string
}

export interface ExtractOptions {
  fileName: string
  /** Held in memory for this call only; never stored or logged. */
  password?: string
  /**
   * Override pdf.js asset locations (packaged app). Defaults resolve pdfjs-dist from node_modules and
   * rewrite `app.asar` to `app.asar.unpacked` (the pdfjs-dist files must be asarUnpack'ed).
   */
  assets?: PdfAssets
}

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<PdfjsModule> | null = null

const unpacked = (p: string): string => p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')

// pdf.js requires factory URLs to end with a forward slash, even on Windows.
const slash = (p: string): string => p.split('\\').join('/') + '/'

export function defaultAssets(): PdfAssets {
  const require = createRequire(import.meta.url)
  const pkgDir = unpacked(dirname(require.resolve('pdfjs-dist/package.json')))
  return {
    workerSrc: pathToFileURL(join(pkgDir, 'legacy', 'build', 'pdf.worker.mjs')).href,
    standardFontDataUrl: slash(join(pkgDir, 'standard_fonts')),
    cMapUrl: slash(join(pkgDir, 'cmaps')),
    iccUrl: slash(join(pkgDir, 'iccs')),
    wasmUrl: slash(join(pkgDir, 'wasm'))
  }
}

async function loadPdfjs(workerSrc: string): Promise<PdfjsModule> {
  // The legacy build is required in Node/Electron main (the modern build needs newer JS/DOM APIs).
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs')
  const m = await pdfjsPromise
  // Applied on EVERY call so an assets override is never ignored after the first load.
  m.GlobalWorkerOptions.workerSrc = workerSrc
  return m
}

/** A page counts as having text when it carries at least this many non-space characters. */
export const MIN_CHARS_PER_TEXT_PAGE = 30

interface RawTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

/**
 * Extracts positioned text items and reconstructed rows for every page. Pure function of
 * bytes + options; safe to run inside a worker thread. Errors contain only file name/page/fixed reason.
 */
export async function extractDocument(bytes: Uint8Array, opts: ExtractOptions): Promise<PdfTextDocument> {
  const { fileName } = opts
  const assets = opts.assets ?? defaultAssets()
  const pdfjs = await loadPdfjs(assets.workerSrc)

  // pdf.js transfers/detaches the buffer it is given, so hand it a copy.
  const data = new Uint8Array(bytes)
  const task = pdfjs.getDocument({
    data,
    password: opts.password,
    standardFontDataUrl: assets.standardFontDataUrl,
    cMapUrl: assets.cMapUrl,
    iccUrl: assets.iccUrl,
    wasmUrl: assets.wasmUrl,
    cMapPacked: true,
    useSystemFonts: false,
    verbosity: 0
  })

  try {
    let pdf: Awaited<typeof task.promise>
    try {
      pdf = await task.promise
    } catch (e) {
      const err = e as { name?: string; code?: number }
      if (err?.name === 'PasswordException') {
        if (err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD) {
          throw new PdfIngestError('PASSWORD_INCORRECT', fileName, 'The password is incorrect.')
        }
        throw new PdfIngestError('PASSWORD_REQUIRED', fileName, 'The PDF is password protected.')
      }
      throw new PdfIngestError('CORRUPT_PDF', fileName, `The file is not a readable PDF (${err?.name ?? 'unknown error'}).`)
    }

    const pages: PdfPage[] = []
    let textPages = 0
    for (let n = 1; n <= pdf.numPages; n++) {
      try {
        const page = await pdf.getPage(n)
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent()
        const items: TextItem[] = []
        let chars = 0
        for (const raw of content.items) {
          if (!('str' in raw)) continue
          const r = raw as unknown as RawTextItem
          if (r.str.trim() === '') continue
          // Map the item from PDF user space into the viewport (top-left origin, honours page rotation/crop).
          const m = pdfjs.Util.transform(viewport.transform, r.transform)
          const x = m[4] ?? 0
          const y = m[5] ?? 0
          const height = r.height || Math.hypot(m[2] ?? 0, m[3] ?? 0) || 8
          items.push({ str: r.str, x, xEnd: x + r.width * viewport.scale, y, height })
          chars += r.str.replace(/\s/g, '').length
        }
        if (chars >= MIN_CHARS_PER_TEXT_PAGE) textPages++
        pages.push({ pageNumber: n, width: viewport.width, height: viewport.height, items, rows: buildRows(items, n) })
        page.cleanup()
      } catch {
        throw new PdfIngestError('CORRUPT_PDF', fileName, 'The page could not be read.', n)
      }
    }
    // A scan with a text footer ("Page 1 of 3") has items but no content: judge per page, not per document.
    if (textPages * 2 < pdf.numPages) {
      throw new PdfIngestError(
        'OCR_NOT_SUPPORTED',
        fileName,
        'This PDF contains no extractable text (it looks like a scan). OCR is not supported.'
      )
    }
    return { fileName, pages }
  } finally {
    await task.destroy()
  }
}
