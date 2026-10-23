import { addDays } from '../../../shared/dates'
import type { Db } from '../../db'
import { countFingerprints, fingerprint, flagDuplicates, occurrenceIndexes } from '../dedupe/fingerprint'
import type { DuplicateGroup, ExistingTransactionSummary, OverlapInfo, ReviewRow, ReviewSession } from './types'

/** Is the row part of what commit would write? */
export function isRowIncluded(session: ReviewSession, r: ReviewRow): boolean {
  if (r.excluded) return false
  if (r.duplicateGroupId) {
    const g = session.duplicateGroups.find((x) => x.id === r.duplicateGroupId)
    if (g?.decision === 'skip') return false
  }
  return true
}

/** Recompute fingerprints, occurrence indexes, duplicate groups and overlap, preserving prior decisions. */
export function recomputeDuplicates(db: Db, session: ReviewSession): void {
  const rows = session.rows
  const fps = rows.map((r) =>
    fingerprint({ accountId: session.accountId, date: r.date, amountCents: r.amountCents, description: r.description })
  )
  const occ = occurrenceIndexes(fps)
  rows.forEach((r, i) => {
    r.fingerprint = fps[i] as string
    r.occurrence = occ[i] as number
  })

  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE fingerprint = ? AND deleted_at IS NULL')
  const existing = new Map<string, number>()
  for (const fp of countFingerprints(fps).keys()) {
    existing.set(fp, (countStmt.get(fp) as { n: number }).n)
  }
  const flags = flagDuplicates(fps, existing)

  const prev = new Map(session.duplicateGroups.map((g) => [g.id, g.decision]))
  const groups = new Map<string, DuplicateGroup>()
  const existingStmt = db.prepare(
    `SELECT id, date, amount_cents AS amountCents, description_raw AS description, import_id AS importId, source
       FROM transactions WHERE fingerprint = ? AND deleted_at IS NULL ORDER BY created_at, id`
  )
  rows.forEach((r, i) => {
    r.duplicateGroupId = null
    if (!flags[i]) return
    const id = r.fingerprint
    let g = groups.get(id)
    if (!g) {
      g = {
        id,
        fingerprint: id,
        decision: prev.get(id) ?? 'pending',
        existing: existingStmt.all(id) as ExistingTransactionSummary[],
        incomingRowIds: []
      }
      groups.set(id, g)
    }
    g.incomingRowIds.push(r.id)
    r.duplicateGroupId = id
  })
  session.duplicateGroups = [...groups.values()]
  session.overlap = computeOverlap(db, session, flags)
}

/** Statement vs CSV exports often differ by a posting-date shift; treat +-3 days as the same activity. */
export const NEAR_MATCH_DAYS = 3

function computeOverlap(db: Db, session: ReviewSession, flags: boolean[]): OverlapInfo {
  const near = db.prepare(
    `SELECT COUNT(*) AS n FROM transactions
      WHERE account_id = ? AND date BETWEEN ? AND ? AND amount_cents = ? AND deleted_at IS NULL
        AND (fingerprint IS NULL OR fingerprint != ?)`
  )
  let nearMatchCount = 0
  session.rows.forEach((r, i) => {
    if (flags[i]) return
    const n = (near.get(
      session.accountId,
      addDays(r.date, -NEAR_MATCH_DAYS),
      addDays(r.date, NEAR_MATCH_DAYS),
      r.amountCents,
      r.fingerprint
    ) as { n: number }).n
    if (n > 0) nearMatchCount++
  })
  const importIds = new Set<string>()
  for (const g of session.duplicateGroups) for (const e of g.existing) if (e.importId) importIds.add(e.importId)
  const dates = session.rows.map((r) => r.date).sort()
  const duplicateRowCount = flags.filter(Boolean).length
  return {
    detected: duplicateRowCount > 0 || nearMatchCount > 0,
    duplicateRowCount,
    nearMatchCount,
    overlappingImportIds: [...importIds],
    dateRange: dates.length ? { from: dates[0] as string, to: dates[dates.length - 1] as string } : null
  }
}
