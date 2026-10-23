import { PdfIngestError, type PdfIngestErrorJSON } from './errors'
import { parseStatementPdf } from './parse'
import type { ParsedStatement } from './types'

export interface ParseRequest {
  id: number
  bytes: Uint8Array
  fileName: string
  /** Lives in worker memory for this one request only. */
  password?: string
}

export type ParseResponse =
  | { id: number; ok: true; statement: ParsedStatement }
  | { id: number; ok: false; error: PdfIngestErrorJSON }

/** Worker-side handler: structured-clone-safe result or error. Never echoes the password or contents. */
export async function handleParseRequest(req: ParseRequest): Promise<ParseResponse> {
  try {
    const statement = await parseStatementPdf(req.bytes, { fileName: req.fileName, password: req.password })
    return { id: req.id, ok: true, statement }
  } catch (e) {
    const err =
      e instanceof PdfIngestError ? e : new PdfIngestError('CORRUPT_PDF', req.fileName, 'The file could not be processed.')
    return { id: req.id, ok: false, error: err.toJSON() }
  }
}
