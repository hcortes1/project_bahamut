import { createHash, randomUUID } from 'node:crypto'
import { recomputeDuplicates } from './duplicates'
import { findImportByHash, getSetting, UNCATEGORIZED_CATEGORY_ID, type Db } from '../../db'
import { parseCsv } from '../csv'
import { normalizeDescription } from '../normalize'
import { parseStatementPdfWithPasswordPrompt } from '../pdf'
import { PipelineError } from './errors'
import type {
  CsvReviewInfo,
  ImportFileType,
  OpenImportOptions,
  PdfReviewInfo,
  ReviewRow,
  ReviewSession
} from './types'
import type { CsvParseOptions } from '../csv'

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85


export function readThreshold(db: Db): number {
  const v = Number(getSetting(db, 'import_confidence_threshold'))
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_CONFIDENCE_THRESHOLD
}

export function readRetainDefault(db: Db): boolean {
  const v = (getSetting(db, 'retain_imports') ?? '').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/** Detect by magic bytes first, then extension. */
export function detectFileType(bytes: Uint8Array, fileName: string): ImportFileType {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  if (head.includes('%PDF-')) return 'pdf'
  if (/\.(csv|txt)$/i.test(fileName)) return 'csv'
  throw new PipelineError('UNSUPPORTED_FILE', 'Only PDF statements and CSV files can be imported.')
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

interface RawRow {
  source: ImportFileType
  date: string
  amountCents: number
  description: string
  confidence: number
}

function toReviewRows(raw: RawRow[], s: Pick<ReviewSession, 'accountId' | 'threshold' | 'categorize'>): ReviewRow[] {
  return raw.map((r, index) => {
    const descriptionNormalized = normalizeDescription(r.description)
    const cat = s.categorize({
      date: r.date,
      amountCents: r.amountCents,
      description: r.description,
      descriptionNormalized
    })
    return {
      id: `r${index}`,
      index,
      source: r.source,
      date: r.date,
      amountCents: r.amountCents,
      description: r.description,
      descriptionNormalized,
      categoryId: cat ?? UNCATEGORIZED_CATEGORY_ID,
      confidence: r.confidence,
      lowConfidence: r.confidence < s.threshold,
      reviewed: false,
      excluded: false,
      edited: false,
      fingerprint: '',
      occurrence: 0,
      duplicateGroupId: null,
      original: { date: r.date, amountCents: r.amountCents, description: r.description }
    }
  })
}

/**
 * Parse a file and build an in-memory review session. Nothing is written to the database.
 */
export async function openImport(db: Db, opts: OpenImportOptions): Promise<ReviewSession> {
  const fileType = detectFileType(opts.bytes, opts.fileName)
  const threshold = opts.threshold ?? readThreshold(db)
  const base = {
    id: randomUUID(),
    status: 'open' as const,
    accountId: opts.accountId,
    fileName: opts.fileName,
    fileType,
    fileHash: sha256(opts.bytes),
    bytes: opts.bytes,
    threshold,
    categorize: opts.categorize ?? ((): null => null)
  }

  let raw: RawRow[]
  let validation: ReviewSession['validation'] = null
  let csv: CsvReviewInfo | null = null
  let pdf: PdfReviewInfo | null = null

  if (fileType === 'pdf') {
    const stmt = await parseStatementPdfWithPasswordPrompt(opts.bytes, {
      fileName: opts.fileName,
      runner: opts.pdfRunner,
      requestPassword: opts.requestPassword ?? ((): Promise<null> => Promise.resolve(null))
    })
    raw = stmt.transactions.map((t) => ({
      source: 'pdf',
      date: t.date,
      amountCents: t.amountCents,
      description: t.description,
      confidence: t.confidence
    }))
    validation = stmt.validation
    pdf = {
      parserId: stmt.parserId,
      accountType: stmt.accountType,
      last4: stmt.last4,
      periodStart: stmt.periodStart,
      periodEnd: stmt.periodEnd,
      statementConfidence: stmt.confidence,
      warnings: stmt.warnings
    }
  } else {
    const parsed = parseCsv(opts.bytes, { delimiter: opts.csvDelimiter, mapping: opts.csvMapping })
    raw = parsed.rows.map((r) => ({
      source: 'csv',
      date: r.date,
      amountCents: r.amountCents,
      description: r.descriptionRaw,
      confidence: r.confidence
    }))
    csv = csvInfo(parsed, threshold, opts.csvMapping !== undefined)
  }

  const session: ReviewSession = {
    ...base,
    rows: toReviewRows(raw, base),
    duplicateGroups: [],
    overlap: { detected: false, duplicateRowCount: 0, nearMatchCount: 0, overlappingImportIds: [], dateRange: null },
    fileDuplicate: null,
    validation,
    csv,
    pdf
  }
  const prior = findImportByHash(db, session.fileHash)
  if (prior) {
    session.fileDuplicate = {
      existingImportId: prior.id,
      existingFileName: prior.fileName,
      existingImportedAt: prior.importedAt,
      acknowledged: false
    }
  }
  recomputeDuplicates(db, session)
  return session
}

function csvInfo(parsed: ReturnType<typeof parseCsv>, threshold: number, userMapped: boolean): CsvReviewInfo {
  // A date column mixing day-first and month-first values is never trusted, whatever the threshold.
  const needs = parsed.mappingConfidence < threshold || parsed.mapping.dateOrderConflict
  return {
    mapping: parsed.mapping,
    headers: parsed.headers,
    delimiter: parsed.delimiter,
    encoding: parsed.encoding,
    mappingConfidence: parsed.mappingConfidence,
    skipped: parsed.skipped,
    warnings: parsed.warnings,
    needsConfirmation: needs,
    confirmed: !needs || userMapped
  }
}

/** Re-run the CSV parse with a user mapping override. Row edits are discarded; the mapping counts as confirmed. */
export function setCsvMapping(db: Db, session: ReviewSession, mapping: NonNullable<CsvParseOptions['mapping']>): void {
  assertOpen(session)
  if (session.fileType !== 'csv') throw new PipelineError('NOT_CSV', 'Mapping only applies to CSV imports.')
  const parsed = parseCsv(session.bytes, { delimiter: session.csv?.delimiter, mapping })
  session.rows = toReviewRows(
    parsed.rows.map((r) => ({
      source: 'csv' as const,
      date: r.date,
      amountCents: r.amountCents,
      description: r.descriptionRaw,
      confidence: r.confidence
    })),
    session
  )
  session.csv = { ...csvInfo(parsed, session.threshold, true) }
  for (const g of session.duplicateGroups) g.decision = 'pending'
  session.duplicateGroups = []
  recomputeDuplicates(db, session)
}

export function confirmCsvMapping(session: ReviewSession): void {
  assertOpen(session)
  if (session.csv) session.csv.confirmed = true
}

/** The user chose to import a file whose hash was already imported. */
export function acknowledgeFileDuplicate(session: ReviewSession): void {
  assertOpen(session)
  if (session.fileDuplicate) session.fileDuplicate.acknowledged = true
}

export function discardImport(session: ReviewSession): void {
  session.status = 'discarded'
  session.bytes = new Uint8Array(0)
  session.rows = []
}


export function assertOpen(session: ReviewSession): void {
  if (session.status !== 'open') throw new PipelineError('SESSION_CLOSED', 'This import is no longer open.')
}
