/**
 * USD money helpers. All amounts are integer cents; no floating point is ever
 * used to represent or accumulate money (parsing works on the digit string).
 */

const AMOUNT_RE =
  /^(\()?\s*([+-])?\s*\$?\s*([+-])?\s*((?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d*)?)\s*([+-]|CR|DR)?\s*(\))?$/i

/**
 * Parse a USD amount string to integer cents, or null if it is not a valid amount.
 * Exactly one sign convention is allowed per value: a leading sign (before or after "$"), a trailing
 * sign, accounting parentheses, or a CR (+) / DR (-) suffix. Mixed markers such as "--5" or "(12.34)-"
 * are rejected rather than guessed at.
 */
export function parseMoneyToCents(input: string): number | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s === '') return null
  const m = AMOUNT_RE.exec(s)
  if (!m) return null
  const [, open, lead1, lead2, body, trail, close] = m
  if (Boolean(open) !== Boolean(close)) return null
  const markers = (open ? 1 : 0) + (lead1 ? 1 : 0) + (lead2 ? 1 : 0) + (trail ? 1 : 0)
  if (markers > 1) return null
  const negative =
    Boolean(open) || lead1 === '-' || lead2 === '-' || trail === '-' || (trail !== undefined && trail.toUpperCase() === 'DR')

  const dot = (body ?? '').indexOf('.')
  const whole = dot < 0 ? (body ?? '') : (body ?? '').slice(0, dot)
  let frac = dot < 0 ? '' : (body ?? '').slice(dot + 1)
  if (whole === '' && frac === '') return null
  if (frac.length > 2) {
    // Allow only redundant trailing zeros (e.g. "1.500"); never silently round.
    if (/^\d{2}0+$/.test(frac)) frac = frac.slice(0, 2)
    else return null
  }
  frac = frac.padEnd(2, '0')
  const wholeDigits = (whole === '' ? '0' : whole).replace(/,/g, '')
  const cents = Number(wholeDigits) * 100 + Number(frac)
  if (!Number.isSafeInteger(cents)) return null
  if (cents === 0) return 0
  return negative ? -cents : cents
}

export interface FormatCentsOptions {
  /** Include the "$" symbol (default true). */
  symbol?: boolean
  /** Insert thousands separators (default true). */
  grouping?: boolean
}

/** Format integer cents as "$1,234.56" / "-$1,234.56". */
export function formatCents(cents: number, opts: FormatCentsOptions = {}): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError('cents must be a safe integer')
  const { symbol = true, grouping = true } = opts
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
  const rem = abs % 100
  let d = String(dollars)
  if (grouping) d = d.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = `${symbol ? '$' : ''}${d}.${String(rem).padStart(2, '0')}`
  return cents < 0 ? `-${body}` : body
}

/** Sum integer cents exactly. */
export function sumCents(values: readonly number[]): number {
  let total = 0
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new RangeError('cents must be a safe integer')
    total += v
  }
  return total
}
