import { getCategory, type Db } from '../../db'
import { normalizeDescription } from '../normalize'
import { isRowIncluded, recomputeDuplicates } from './duplicates'
import { PipelineError } from './errors'
import { assertOpen } from './session'
import type { CommitBlockers, DuplicateDecision, ReviewRow, ReviewSession, ReviewView, RowEdit } from './types'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function validIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function row(session: ReviewSession, rowId: string): ReviewRow {
  const r = session.rows.find((x) => x.id === rowId)
  if (!r) throw new PipelineError('UNKNOWN_ROW', 'No such row.')
  return r
}

/** Edit date/amount/description/category. Editing a low-confidence row counts as reviewing it. */
export function editRow(db: Db, session: ReviewSession, rowId: string, edit: RowEdit): void {
  assertOpen(session)
  const r = row(session, rowId)
  if (edit.date !== undefined && !validIsoDate(edit.date)) throw new PipelineError('INVALID_EDIT', 'Date must be YYYY-MM-DD.')
  if (edit.amountCents !== undefined && !Number.isSafeInteger(edit.amountCents)) {
    throw new PipelineError('INVALID_EDIT', 'Amount must be an integer number of cents.')
  }
  if (edit.description !== undefined && edit.description.trim() === '') {
    throw new PipelineError('INVALID_EDIT', 'Description cannot be empty.')
  }
  if (edit.categoryId !== undefined && !getCategory(db, edit.categoryId)) {
    throw new PipelineError('INVALID_EDIT', 'Unknown category.')
  }
  if (edit.date !== undefined) r.date = edit.date
  if (edit.amountCents !== undefined) r.amountCents = edit.amountCents
  if (edit.description !== undefined) {
    r.description = edit.description.trim()
    r.descriptionNormalized = normalizeDescription(r.description)
  }
  if (edit.categoryId !== undefined) r.categoryId = edit.categoryId
  r.edited = true
  if (r.lowConfidence) r.reviewed = true
  if (edit.date !== undefined || edit.amountCents !== undefined || edit.description !== undefined) {
    recomputeDuplicates(db, session)
  }
}

export function setExcluded(session: ReviewSession, rowId: string, excluded: boolean): void {
  assertOpen(session)
  const r = row(session, rowId)
  r.excluded = excluded
  if (excluded && r.lowConfidence) r.reviewed = true
}

/** Individually confirm a low-confidence row as-is. */
export function confirmRow(session: ReviewSession, rowId: string): void {
  assertOpen(session)
  row(session, rowId).reviewed = true
}

export function bulkSetCategory(db: Db, session: ReviewSession, rowIds: readonly string[], categoryId: string): void {
  assertOpen(session)
  if (!getCategory(db, categoryId)) throw new PipelineError('INVALID_EDIT', 'Unknown category.')
  const rows = rowIds.map((id) => row(session, id))
  for (const r of rows) {
    r.categoryId = categoryId
    r.edited = true
  }
}

export function resolveDuplicate(session: ReviewSession, groupId: string, decision: Exclude<DuplicateDecision, 'pending'>): void {
  assertOpen(session)
  const g = session.duplicateGroups.find((x) => x.id === groupId)
  if (!g) throw new PipelineError('UNKNOWN_GROUP', 'No such duplicate group.')
  g.decision = decision
}

/** "Apply to all remaining": sets the decision on every still-pending group. */
export function resolveRemainingDuplicates(session: ReviewSession, decision: Exclude<DuplicateDecision, 'pending'>): void {
  assertOpen(session)
  for (const g of session.duplicateGroups) if (g.decision === 'pending') g.decision = decision
}

export function getCommitBlockers(session: ReviewSession): CommitBlockers {
  const codes: CommitBlockers['codes'] = []
  if (session.status !== 'open') codes.push('NOT_OPEN')
  const lowConfidencePending = session.rows.filter((r) => r.lowConfidence && !r.reviewed && !r.excluded).length
  const duplicatesPending = session.duplicateGroups.filter((g) => g.decision === 'pending').length
  if (session.fileDuplicate && !session.fileDuplicate.acknowledged) codes.push('FILE_DUPLICATE_UNACKNOWLEDGED')
  if (session.csv && !session.csv.confirmed) codes.push('MAPPING_UNCONFIRMED')
  if (lowConfidencePending > 0) codes.push('LOW_CONFIDENCE_PENDING')
  if (duplicatesPending > 0) codes.push('DUPLICATES_PENDING')
  if (!session.rows.some((r) => isRowIncluded(session, r)) && duplicatesPending === 0) codes.push('NOTHING_TO_IMPORT')
  return { codes, lowConfidencePending, duplicatesPending }
}

/** Serializable snapshot for the renderer (no file bytes, no functions). */
export function toReviewView(session: ReviewSession): ReviewView {
  const { bytes: _bytes, categorize: _categorize, ...view } = session
  void _bytes
  void _categorize
  return structuredClone(view)
}
