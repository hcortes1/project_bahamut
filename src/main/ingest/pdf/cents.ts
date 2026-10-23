// Thin PDF-side wrappers over the shared money/date helpers. The only logic kept locally is the STRICT
// money detector: statement cells must have exactly two decimals so reference numbers ("1041"), page
// numbers and bare integers are never mistaken for amounts.
import { isValidYmd, toIsoDate } from '../../../shared/dates'
import { formatCents as formatShared, parseMoneyToCents } from '../../../shared/money'

const STRICT_MONEY = /^[()+\-\s$]*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}[()+\-\s]*$/

/** True for a cell that is formatted as a money amount with exactly two decimals. */
export function isMoney(raw: string): boolean {
  return STRICT_MONEY.test(raw.trim()) && parseMoneyToCents(raw) !== null
}

/** Parses "1,234.56", "-$45.67", "(12.00)", "12.00-" into signed integer cents. Null when not a strict money string. */
export function parseCents(raw: string): number | null {
  return isMoney(raw) ? parseMoneyToCents(raw) : null
}

/** Signed cents to "-1,234.56" (integer math only). */
export function formatCents(cents: number): string {
  return formatShared(cents, { symbol: false })
}

export function isoDate(y: number, m: number, d: number): string | null {
  return isValidYmd(y, m, d) ? toIsoDate(y, m, d) : null
}
