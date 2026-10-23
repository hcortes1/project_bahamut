import { z } from 'zod'
import { addDays, daysInMonth, isIsoDate, parseIsoDate, toIsoDate } from '@shared/dates'

/** Upper bound on any single amount: $10 billion in cents. Keeps all products below 2^53. */
export const MAX_CENTS = 1_000_000_000_000

export const SafeCents = z.number().int().min(-MAX_CENTS).max(MAX_CENTS)
export const PositiveCents = z.number().int().min(1).max(MAX_CENTS)
export const NonZeroCents = SafeCents.refine((n) => n !== 0, 'amount must not be zero')
export const ValidDate = z.string().refine(isIsoDate, 'must be a valid YYYY-MM-DD date')
export const ValidMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM')
  .refine((m) => isIsoDate(`${m}-01`), 'invalid month')
export const Id = z.string().min(1)

export class FeatureError extends Error {
  constructor(
    public readonly code: string,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'FeatureError'
  }
}

export const firstOfMonth = (month: string): string => `${month}-01`
export function lastOfMonth(month: string): string {
  const p = parseIsoDate(firstOfMonth(month))
  if (!p) throw new RangeError('invalid month')
  return toIsoDate(p.year, p.month, daysInMonth(p.year, p.month))
}
export const monthOf = (iso: string): string => iso.slice(0, 7)

/** Next month string: 2026-12 becomes 2027-01. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/**
 * Add whole months, clamping the day to the target month's length. `anchorDay`
 * (default: the date's own day) prevents drift: the 31st goes to Feb 28 and
 * then back to Mar 31 when anchored.
 */
export function addMonths(iso: string, months: number, anchorDay?: number): string {
  const p = parseIsoDate(iso)
  if (!p) throw new RangeError('invalid ISO date')
  const idx = p.year * 12 + (p.month - 1) + months
  const year = Math.floor(idx / 12)
  const month = (idx % 12) + 1
  const day = Math.min(anchorDay ?? p.day, daysInMonth(year, month))
  return toIsoDate(year, month, day)
}

export { addDays }
