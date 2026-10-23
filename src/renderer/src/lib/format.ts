import { formatCents, parseMoneyToCents } from '@shared/money'

export { formatCents, parseMoneyToCents }

/** Cents -> plain editable text such as "1234.50" (no symbol, no grouping). */
export const centsToInput = (cents: number): string => formatCents(cents, { symbol: false, grouping: false })

/** User text -> integer cents, or null when it is not a valid amount. */
export const parseAmountInput = (text: string): number | null => parseMoneyToCents(text)

/** Chart axis tick: whole cents only. Chart.js can ask for fractional ticks on all-zero data; formatCents would throw. */
export const formatTick = (v: number): string => (Number.isInteger(v) ? formatCents(v) : '')

/** Local calendar date as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

/** Milliseconds -> "mm:ss". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
