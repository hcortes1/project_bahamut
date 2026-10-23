import { bofaParser } from './bofa'
import { PdfIngestError } from './errors'
import { extractDocument, type PdfAssets } from './extract'
import type { ParsedStatement, PdfTextDocument, StatementParser } from './types'

export const STATEMENT_PARSERS: readonly StatementParser[] = [bofaParser]

export interface ParseOptions {
  fileName: string
  /** Used for this call only; not stored, not logged. */
  password?: string
  assets?: PdfAssets
}

/** Runs the registered parsers on an already extracted document. */
export function parseDocument(doc: PdfTextDocument, parsers: readonly StatementParser[] = STATEMENT_PARSERS): ParsedStatement {
  const parser = parsers.find((p) => p.canParse(doc))
  if (!parser) {
    throw new PdfIngestError('NOT_A_STATEMENT', doc.fileName, 'This PDF is not a supported Bank of America statement.')
  }
  return parser.parse(doc)
}

/** Pure function of bytes + options -> result. Runs in whatever thread calls it (the pdf worker in the app). */
export async function parseStatementPdf(bytes: Uint8Array, opts: ParseOptions): Promise<ParsedStatement> {
  const doc = await extractDocument(bytes, opts)
  return parseDocument(doc)
}
