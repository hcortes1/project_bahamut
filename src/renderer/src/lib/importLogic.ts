import type { CommitBlockersDto, ReviewRowDto } from '@shared/ipc'

const BLOCKER_TEXT: Record<string, string> = {
  NOT_OPEN: 'This review is closed.',
  FILE_DUPLICATE_UNACKNOWLEDGED: 'This file was imported before. Acknowledge that you want to import it again.',
  MAPPING_UNCONFIRMED: 'Confirm the detected CSV column mapping.',
  NOTHING_TO_IMPORT: 'No rows are left to import.'
}

/** Plain-language reasons the Commit button is disabled. Empty when the import can be committed. */
export function blockerMessages(b: CommitBlockersDto): string[] {
  const out: string[] = []
  for (const code of b.codes) {
    if (code === 'LOW_CONFIDENCE_PENDING') {
      out.push(`${b.lowConfidencePending} low-confidence ${b.lowConfidencePending === 1 ? 'row needs' : 'rows need'} to be confirmed, edited or excluded.`)
    } else if (code === 'DUPLICATES_PENDING') {
      out.push(`${b.duplicatesPending} possible ${b.duplicatesPending === 1 ? 'duplicate needs' : 'duplicates need'} a decision.`)
    } else out.push(BLOCKER_TEXT[code] ?? 'This import is not ready to commit.')
  }
  return out
}

export const canCommit = (b: CommitBlockersDto | null): boolean => b !== null && b.codes.length === 0

/** Rows that still need an explicit decision (the "confirm all" action targets exactly these). */
export const pendingConfirmIds = (rows: readonly ReviewRowDto[]): string[] =>
  rows.filter((r) => r.lowConfidence && !r.reviewed && !r.excluded).map((r) => r.id)

export const confidencePercent = (c: number): number => Math.round(c * 100)

/** Column choices for the CSV mapping panel. */
export function columnOptions(headers: string[] | null, fallbackCount = 12): { index: number; label: string }[] {
  const n = headers?.length ?? fallbackCount
  return Array.from({ length: n }, (_, i) => ({ index: i, label: headers?.[i] ? `${i + 1}: ${headers[i]}` : `Column ${i + 1}` }))
}
