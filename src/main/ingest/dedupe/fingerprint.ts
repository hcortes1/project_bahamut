import { createHash } from 'node:crypto'
import { NORMALIZATION_VERSION, normalizeDescription } from '../normalize'

export interface FingerprintInput {
  accountId: string
  /** ISO date YYYY-MM-DD */
  date: string
  amountCents: number
  /** Raw description; it is normalized here. */
  description: string
}

/**
 * sha256 hex of NORMALIZATION_VERSION + account_id + date + amount_cents + normalized description.
 * The version prefix means a normalization change can never silently produce false matches against
 * fingerprints stored under older rules.
 */
export function fingerprint(t: FingerprintInput): string {
  const key = [`n${NORMALIZATION_VERSION}`, t.accountId, t.date, String(t.amountCents), normalizeDescription(t.description)].join('\u001f')
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/**
 * 0-based occurrence index of each fingerprint within one file, in order.
 * Two identical $4.50 coffees on one day get indexes 0 and 1.
 */
export function occurrenceIndexes(fingerprints: readonly string[]): number[] {
  const seen = new Map<string, number>()
  return fingerprints.map((fp) => {
    const n = seen.get(fp) ?? 0
    seen.set(fp, n + 1)
    return n
  })
}

/** Distinct key for the n-th occurrence of a fingerprint (stable storage value). */
export function occurrenceKey(fp: string, occurrence: number): string {
  return `${fp}:${occurrence}`
}

/** Count of fingerprints already stored by prior imports. */
export type ExistingCounts = ReadonlyMap<string, number>

export function countFingerprints(fingerprints: readonly string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const fp of fingerprints) m.set(fp, (m.get(fp) ?? 0) + 1)
  return m
}

/**
 * Flag incoming rows that duplicate prior imports. The n-th occurrence (0-based)
 * of a fingerprint is a duplicate only if prior imports already hold more than n
 * of them; extra identical rows beyond the existing count stay new.
 */
export function flagDuplicates(incoming: readonly string[], existing: ExistingCounts): boolean[] {
  const occ = occurrenceIndexes(incoming)
  return incoming.map((fp, i) => (existing.get(fp) ?? 0) > (occ[i] ?? 0))
}
