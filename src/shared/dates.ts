/** ISO (YYYY-MM-DD) date helpers and multi-format date parsing. Timezone-free. */

export type DateOrder = 'MDY' | 'DMY' | 'YMD'

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function isValidYmd(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 1900 &&
    year <= 2999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  )
}

export function toIsoDate(year: number, month: number, day: number): string {
  if (!isValidYmd(year, month, day)) throw new RangeError('invalid date')
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return !!m && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]))
}

export function parseIsoDate(s: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  return isValidYmd(year, month, day) ? { year, month, day } : null
}

function isoToUtcMs(s: string): number {
  const p = parseIsoDate(s)
  if (!p) throw new RangeError('invalid ISO date')
  return Date.UTC(p.year, p.month - 1, p.day)
}

function utcMsToIso(ms: number): string {
  const d = new Date(ms)
  return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

export function addDays(iso: string, days: number): string {
  return utcMsToIso(isoToUtcMs(iso) + days * 86_400_000)
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((isoToUtcMs(b) - isoToUtcMs(a)) / 86_400_000)
}

export function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Two-digit years: 00-69 -> 2000s, 70-99 -> 1900s. */
export function expandYear(y: number, digits: number): number {
  if (digits >= 4) return y
  return y < 70 ? 2000 + y : 1900 + y
}

type Shape =
  | { kind: 'ymd'; y: number; m: number; d: number }
  | { kind: 'named'; y: number; m: number; d: number }
  | { kind: 'pair'; a: number; b: number; y: number }
  | { kind: 'noyear'; a: number; b: number }

function shapeOf(raw: string): Shape | null {
  const s = raw.trim().replace(/\s+/g, ' ')
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s)
  if (m) return { kind: 'ymd', y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return { kind: 'ymd', y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?:[T ].*)?$/.exec(s)
  if (m) return { kind: 'pair', a: Number(m[1]), b: Number(m[2]), y: expandYear(Number(m[3]), (m[3] ?? '').length) }
  // "Jan 5, 2024"
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4}|\d{2})$/.exec(s)
  if (m) {
    const mi = MONTHS.indexOf((m[1] ?? '').slice(0, 3).toUpperCase())
    if (mi >= 0) return { kind: 'named', y: expandYear(Number(m[3]), (m[3] ?? '').length), m: mi + 1, d: Number(m[2]) }
  }
  // "5 Jan 2024", "05-JAN-2024"
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ ,-]+(\d{4}|\d{2})$/.exec(s)
  if (m) {
    const mi = MONTHS.indexOf((m[2] ?? '').slice(0, 3).toUpperCase())
    if (mi >= 0) return { kind: 'named', y: expandYear(Number(m[3]), (m[3] ?? '').length), m: mi + 1, d: Number(m[1]) }
  }
  m = /^(\d{1,2})[/-](\d{1,2})$/.exec(s)
  if (m) return { kind: 'noyear', a: Number(m[1]), b: Number(m[2]) }
  return null
}

export interface DateOrderResult {
  order: DateOrder
  /** True when every numeric value was compatible with both MM/DD and DD/MM. */
  ambiguous: boolean
  /** True when some values rule out MDY and others rule out DMY. */
  conflict: boolean
}

/**
 * Decide day/month order from every value in a column. A value such as 13/05
 * rules out MM/DD; 05/13 rules out DD/MM. Fully ambiguous files default to the
 * US order (MDY) and are flagged ambiguous. Year-first formats win outright.
 */
export function detectDateOrder(values: readonly string[], fallback: DateOrder = 'MDY'): DateOrderResult {
  let mdyPossible = true
  let dmyPossible = true
  let sawYmd = false
  let sawPair = false
  for (const v of values) {
    const sh = shapeOf(v)
    if (!sh) continue
    if (sh.kind === 'ymd') sawYmd = true
    else if (sh.kind === 'pair' || sh.kind === 'noyear') {
      sawPair = true
      if (sh.a > 12) mdyPossible = false
      if (sh.b > 12) dmyPossible = false
    }
  }
  if (sawYmd && !sawPair) return { order: 'YMD', ambiguous: false, conflict: false }
  if (!sawPair) return { order: fallback, ambiguous: false, conflict: false }
  if (!mdyPossible && !dmyPossible) return { order: fallback, ambiguous: false, conflict: true }
  if (!mdyPossible) return { order: 'DMY', ambiguous: false, conflict: false }
  if (!dmyPossible) return { order: 'MDY', ambiguous: false, conflict: false }
  return { order: fallback, ambiguous: true, conflict: false }
}

/** Parse one date string to ISO using the given order for numeric pairs. Null when invalid. */
export function parseDate(raw: string, order: DateOrder = 'MDY', defaultYear?: number): string | null {
  if (typeof raw !== 'string') return null
  const sh = shapeOf(raw)
  if (!sh) return null
  let y: number
  let m: number
  let d: number
  if (sh.kind === 'ymd' || sh.kind === 'named') {
    y = sh.y
    m = sh.m
    d = sh.d
  } else {
    if (sh.kind === 'pair') y = sh.y
    else if (defaultYear === undefined) return null
    else y = defaultYear
    if (order === 'DMY') {
      d = sh.a
      m = sh.b
    } else {
      m = sh.a
      d = sh.b
    }
  }
  return isValidYmd(y, m, d) ? toIsoDate(y, m, d) : null
}

/** Whole-column parse: resolve order from all values, then parse each. */
export function parseDates(
  values: readonly string[],
  fallback: DateOrder = 'MDY'
): DateOrderResult & { dates: (string | null)[] } {
  const res = detectDateOrder(values, fallback)
  return { ...res, dates: values.map((v) => parseDate(v, res.order)) }
}

/** True when the string looks like a complete date (with year) in a supported format. */
export function looksLikeDate(raw: string): boolean {
  const sh = shapeOf(raw)
  if (!sh || sh.kind === 'noyear') return false
  if (sh.kind === 'pair') return isValidYmd(sh.y, sh.a, sh.b) || isValidYmd(sh.y, sh.b, sh.a)
  return isValidYmd(sh.y, sh.m, sh.d)
}

/**
 * Resolve the year of a yearless statement date (month/day) against the statement period.
 * Candidate years are startYear-1, startYear, endYear and endYear+1; the winner is the one whose date
 * falls inside (or nearest to) [periodStart - 45 days, periodEnd + 7 days]. Ties go to the date nearest
 * the period itself. Returns null when no candidate is a real calendar date (e.g. 02/30) or the best one is
 * implausibly far (more than 100 days) from the period.
 */
export function inferStatementDate(month: number, day: number, periodStart: string, periodEnd: string): string | null {
  const s = parseIsoDate(periodStart)
  const e = parseIsoDate(periodEnd)
  if (!s || !e) return null
  const lo = addDays(periodStart, -45)
  const hi = addDays(periodEnd, 7)
  const gap = (iso: string, from: string, to: string): number =>
    iso < from ? daysBetween(iso, from) : iso > to ? daysBetween(to, iso) : 0
  let best: { iso: string; windowGap: number; periodGap: number } | null = null
  for (const y of new Set([s.year - 1, s.year, e.year, e.year + 1])) {
    if (!isValidYmd(y, month, day)) continue
    const iso = toIsoDate(y, month, day)
    const cand = { iso, windowGap: gap(iso, lo, hi), periodGap: gap(iso, periodStart, periodEnd) }
    if (!best || cand.windowGap < best.windowGap || (cand.windowGap === best.windowGap && cand.periodGap < best.periodGap)) {
      best = cand
    }
  }
  return best && best.windowGap <= 100 ? best.iso : null
}
