import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { PdfIngestError } from './errors'
import { parseStatementPdf } from './parse'
import type { ParseRequest, ParseResponse } from './request'
import type { ParsedStatement } from './types'

export interface PdfParseJob {
  bytes: Uint8Array
  fileName: string
  /** Sent to the parser for this one job only; never stored or logged. */
  password?: string
}

/** Parses one PDF. Rejects with PdfIngestError (never with file contents or the password). */
export type PdfParseRunner = (job: PdfParseJob) => Promise<ParsedStatement>

export const DEFAULT_PARSE_TIMEOUT_MS = 60_000

/** In-process runner. Used by unit tests only (the app always parses in a worker thread). */
export const inProcessRunner: PdfParseRunner = (job) =>
  parseStatementPdf(job.bytes, { fileName: job.fileName, password: job.password })

const unpacked = (p: string): string => p.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked')

/**
 * Locate the built pdf worker (`pdf-worker.js`, the 'pdf-worker' entry in electron.vite.config.ts) next to
 * the main bundle. Dev and packaged builds both emit it beside the entry chunks in out/main. Inside an
 * asar archive worker_threads cannot load the script, so the app.asar.unpacked copy is preferred when it
 * exists (it must be listed in asarUnpack). Returns null when no built worker exists (e.g. under vitest).
 */
export function findPdfWorkerPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const dir of [here, join(here, '..'), join(here, '..', '..')]) {
    const candidate = join(dir, 'pdf-worker.js')
    const real = unpacked(candidate)
    if (real !== candidate && existsSync(real)) return real
    if (existsSync(candidate)) return candidate
  }
  return null
}

export interface WorkerRunnerOptions {
  workerPath: string
  timeoutMs?: number
}

/**
 * One FRESH worker thread per parse: the bytes and optional password are posted to it, and the thread is
 * terminated as soon as it answers, fails, or times out, so a password never outlives its parse.
 */
export function createWorkerRunner(opts: WorkerRunnerOptions): PdfParseRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS
  return (job) =>
    new Promise<ParsedStatement>((resolve, reject) => {
      let settled = false
      let worker: Worker | null = null
      let timer: NodeJS.Timeout | null = null
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (worker) void worker.terminate()
        fn()
      }
      const failed = (): PdfIngestError => new PdfIngestError('CORRUPT_PDF', job.fileName, 'The file could not be processed.')
      try {
        worker = new Worker(opts.workerPath, { name: 'flujo-pdf', resourceLimits: { maxOldGenerationSizeMb: 1024 } })
      } catch {
        reject(failed())
        return
      }
      timer = setTimeout(
        () => finish(() => reject(new PdfIngestError('PARSE_TIMEOUT', job.fileName, 'Reading the PDF took too long and was stopped.'))),
        timeoutMs
      )
      worker.once('message', (res: ParseResponse) =>
        finish(() => (res.ok ? resolve(res.statement) : reject(PdfIngestError.fromJSON(res.error))))
      )
      // Worker errors can carry text from the failing code; surface only a fixed message.
      worker.once('error', () => finish(() => reject(failed())))
      worker.once('exit', () => finish(() => reject(failed())))
      // The session keeps its own bytes: send a copy and transfer that.
      const copy = new Uint8Array(job.bytes)
      const req: ParseRequest = { id: 1, bytes: copy, fileName: job.fileName, password: job.password }
      worker.postMessage(req, [copy.buffer])
    })
}

/** The runner the app uses: a worker thread. Falls back to in-process ONLY when running under vitest. */
export function defaultPdfRunner(): PdfParseRunner {
  const workerPath = findPdfWorkerPath()
  if (workerPath) return createWorkerRunner({ workerPath })
  if (process.env.VITEST) return inProcessRunner
  return (job) => Promise.reject(new PdfIngestError('CORRUPT_PDF', job.fileName, 'The PDF reader is not available.'))
}
