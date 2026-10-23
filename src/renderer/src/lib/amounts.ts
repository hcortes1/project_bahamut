import { parseMoneyToCents } from '@shared/money'

export type Direction = 'expense' | 'income'

/** Parse a positive amount typed by the user (a leading minus is ignored). Null when invalid or zero. */
export function parsePositiveCents(text: string): number | null {
  const c = parseMoneyToCents(text)
  if (c === null || c === 0) return null
  return Math.abs(c)
}

/** Expense -> negative cents, income -> positive cents. */
export const signedCents = (dir: Direction, positive: number): number => (dir === 'expense' ? -positive : positive)

export const directionOf = (cents: number): Direction => (cents < 0 ? 'expense' : 'income')

/** Progress bar width: 0 to 100, tolerating null and overshoot. */
export function clampPercent(p: number | null): number {
  if (p === null || !Number.isFinite(p)) return 0
  return Math.min(100, Math.max(0, p))
}

/** Page of results fetched with limit+1: split into the visible rows and a has-next flag. */
export function splitPage<T>(rows: T[], pageSize: number): { rows: T[]; hasNext: boolean } {
  return { rows: rows.slice(0, pageSize), hasNext: rows.length > pageSize }
}
