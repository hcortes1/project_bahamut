export type PdfErrorCode =
  | 'PASSWORD_REQUIRED'
  | 'PASSWORD_INCORRECT'
  | 'PASSWORD_RETRIES_EXHAUSTED'
  | 'OCR_NOT_SUPPORTED'
  | 'CORRUPT_PDF'
  | 'NOT_A_STATEMENT'
  | 'PARSE_TIMEOUT'

export interface PdfIngestErrorJSON {
  code: PdfErrorCode
  fileName: string
  page: number | null
  reason: string
}

/**
 * Rejection error for PDF ingestion. Carries only the file name, an optional page number and a fixed
 * human-readable reason. It must never contain file contents, text items, or passwords.
 */
export class PdfIngestError extends Error {
  readonly code: PdfErrorCode
  readonly fileName: string
  readonly page: number | null
  readonly reason: string

  constructor(code: PdfErrorCode, fileName: string, reason: string, page: number | null = null) {
    super(`${fileName}${page !== null ? ` (page ${page})` : ''}: ${reason}`)
    this.name = 'PdfIngestError'
    this.code = code
    this.fileName = fileName
    this.page = page
    this.reason = reason
  }

  toJSON(): PdfIngestErrorJSON {
    return { code: this.code, fileName: this.fileName, page: this.page, reason: this.reason }
  }

  static fromJSON(j: PdfIngestErrorJSON): PdfIngestError {
    return new PdfIngestError(j.code, j.fileName, j.reason, j.page)
  }
}
