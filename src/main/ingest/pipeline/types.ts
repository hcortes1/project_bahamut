import type { Transaction } from '@shared/db-types'
import type { CsvMapping, CsvParseOptions, SkippedCounts } from '../csv'
import type { ArithmeticValidation, ParseWarning, PdfParseRunner } from '../pdf'

export type ImportFileType = 'pdf' | 'csv'
export type DuplicateDecision = 'pending' | 'skip' | 'import'

/** What `categorize` receives; pure data, no db access required. */
export interface CategorizeInput {
  date: string
  amountCents: number
  description: string
  descriptionNormalized: string
}

/** Pluggable categorizer. Return a category id, or null for Uncategorized. */
export type CategorizeFn = (row: CategorizeInput) => string | null

export interface ReviewRow {
  /** Stable within the session ("r0", "r1", ...). */
  id: string
  /** Position in the source file after parsing. */
  index: number
  source: ImportFileType
  date: string
  amountCents: number
  description: string
  descriptionNormalized: string
  categoryId: string
  /** Parser confidence 0..1 (never altered by user edits). */
  confidence: number
  /** confidence < session.threshold at parse time. */
  lowConfidence: boolean
  /** Low-confidence row the user confirmed or edited. */
  reviewed: boolean
  /** User excluded the row. */
  excluded: boolean
  edited: boolean
  /** Fingerprint of the current (possibly edited) values. */
  fingerprint: string
  /** 0-based occurrence of this fingerprint within the file. */
  occurrence: number
  /** Set when this row duplicates a prior import (group id = fingerprint). */
  duplicateGroupId: string | null
  original: { date: string; amountCents: number; description: string }
}

export interface ExistingTransactionSummary {
  id: string
  date: string
  amountCents: number
  description: string
  importId: string | null
  source: Transaction['source']
}

export interface DuplicateGroup {
  id: string
  fingerprint: string
  decision: DuplicateDecision
  /** Rows already in the database, for the side-by-side view. */
  existing: ExistingTransactionSummary[]
  /** Incoming row ids flagged as duplicates (extra rows beyond the existing count are not listed). */
  incomingRowIds: string[]
}

export interface OverlapInfo {
  detected: boolean
  /** Incoming rows that duplicate prior imports. */
  duplicateRowCount: number
  /** Incoming rows with same account/date/amount as an existing row but a different description. */
  nearMatchCount: number
  overlappingImportIds: string[]
  dateRange: { from: string; to: string } | null
}

export interface FileDuplicate {
  existingImportId: string
  existingFileName: string
  existingImportedAt: string
  /** The user must set this true (re-import anyway) before commit. */
  acknowledged: boolean
}

export interface CsvReviewInfo {
  mapping: CsvMapping
  headers: string[] | null
  delimiter: string
  encoding: string
  mappingConfidence: number
  skipped: SkippedCounts
  warnings: string[]
  /** Required when mappingConfidence is below the threshold. */
  needsConfirmation: boolean
  confirmed: boolean
}

export interface PdfReviewInfo {
  parserId: string
  accountType: string
  last4: string | null
  periodStart: string
  periodEnd: string
  statementConfidence: number
  warnings: ParseWarning[]
}

export interface ReviewSession {
  id: string
  status: 'open' | 'committed' | 'discarded'
  accountId: string
  fileName: string
  fileType: ImportFileType
  fileHash: string
  /** Held in memory only, for CSV re-mapping and retention. Omitted from `toReviewView`. */
  bytes: Uint8Array
  threshold: number
  rows: ReviewRow[]
  duplicateGroups: DuplicateGroup[]
  overlap: OverlapInfo
  fileDuplicate: FileDuplicate | null
  /** PDF statement arithmetic check (null for CSV). */
  validation: ArithmeticValidation | null
  csv: CsvReviewInfo | null
  pdf: PdfReviewInfo | null
  categorize: CategorizeFn
}

export type ReviewView = Omit<ReviewSession, 'bytes' | 'categorize'>

export type CommitBlocker =
  | 'NOT_OPEN'
  | 'NOTHING_TO_IMPORT'
  | 'FILE_DUPLICATE_UNACKNOWLEDGED'
  | 'MAPPING_UNCONFIRMED'
  | 'LOW_CONFIDENCE_PENDING'
  | 'DUPLICATES_PENDING'

export interface CommitBlockers {
  codes: CommitBlocker[]
  lowConfidencePending: number
  duplicatesPending: number
}

export interface RowEdit {
  date?: string
  amountCents?: number
  description?: string
  categoryId?: string
}

export interface OpenImportOptions {
  /** Account the rows will belong to. */
  accountId: string
  fileName: string
  bytes: Uint8Array
  categorize?: CategorizeFn
  /** CSV only: user mapping override applied over detection. */
  csvMapping?: CsvParseOptions['mapping']
  csvDelimiter?: string
  /** PDF only: called when a password is needed; resolve null/undefined to cancel. */
  requestPassword?: (attempt: number, reason: 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT') => Promise<string | null | undefined>
  /** PDF only: how a parse runs. Default: a fresh worker thread per attempt (tests inject their own). */
  pdfRunner?: PdfParseRunner
  /** Overrides the setting `import_confidence_threshold` (default 0.85). */
  threshold?: number
}

export interface CommitOptions {
  /** Defaults to setting `retain_imports`. */
  keepSourceFile?: boolean
  /** Directory the retained copy is written to; required when keeping the file. */
  retainDir?: string
}

export interface CommitResult {
  importId: string
  inserted: number
  skippedDuplicates: number
  excluded: number
  retainedFilePath: string | null
}
