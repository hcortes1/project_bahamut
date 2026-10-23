import { MAX_MONTHS, MIN_MONTHS, type Eligibility, type OptTransaction } from './types'

export const monthOf = (date: string): string => date.slice(0, 7)

const ym = (y: number, m: number): string => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`

export function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4))
  const mo = Number(m.slice(5, 7))
  return mo === 12 ? ym(y + 1, 1) : ym(y, mo + 1)
}

export function prevMonth(m: string): string {
  const y = Number(m.slice(0, 4))
  const mo = Number(m.slice(5, 7))
  return mo === 1 ? ym(y - 1, 12) : ym(y, mo - 1)
}

export function monthRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m)
  return out
}

/**
 * Complete months = calendar months from the earliest transaction's month through the month before
 * `today`'s month (the current partial month is excluded; gaps count as zero-data months).
 */
export function computeEligibility(txs: readonly OptTransaction[], today: string): Eligibility {
  const lastComplete = prevMonth(monthOf(today))
  let earliest: string | null = null
  for (const t of txs) {
    const m = monthOf(t.date)
    if (m <= lastComplete && (earliest === null || m < earliest)) earliest = m
  }
  const all = earliest === null ? [] : monthRange(earliest, lastComplete)
  const available = all.length
  const eligible = available >= MIN_MONTHS
  const windowMonths = eligible ? all.slice(-MAX_MONTHS) : []
  return {
    eligible,
    requiredMonths: MIN_MONTHS,
    availableMonths: available,
    windowMonths,
    message: eligible
      ? `Using the most recent ${windowMonths.length} complete months.`
      : `The optimizer needs at least ${MIN_MONTHS} complete months of data; ${available} available.`
  }
}
