import { formatCents } from '@shared/money'
import { mean, median, scaledMad } from './stats'
import type { BudgetSuggestion, OptBudget, SpendingSummary } from './types'

const ROUND_UP_TO_CENTS = 500
const MIN_ACTIVE_MONTHS = 3
const TREND_BAND = 0.1

/**
 * Suggested monthly budget per category from the median and trend. One-time large months are capped
 * (winsorized at median + 3 robust deviations) before the trend is read, so a car repair does not
 * inflate next month's budget. Categories with spend in fewer than 3 months are skipped.
 */
export function suggestBudgets(spending: SpendingSummary, budgets: readonly OptBudget[]): BudgetSuggestion[] {
  const out: BudgetSuggestion[] = []
  const latestBudget = new Map<string, OptBudget>()
  for (const b of budgets) {
    const cur = latestBudget.get(b.categoryId)
    if (!cur || b.month > cur.month) latestBudget.set(b.categoryId, b)
  }
  for (const c of spending.categories) {
    if (c.categoryId === null) continue
    const v = c.monthlyCents
    const active = v.filter((x) => x > 0)
    if (active.length < MIN_ACTIVE_MONTHS) continue
    const med = median(v)
    const center = med > 0 ? med : median(active)
    const cap = center + 3 * Math.max(scaledMad(v), 0.1 * center)
    // A sustained shift (all of the last 3 months above the cap) is a new level, not a one-time spike.
    const n = v.length
    const sustained = n >= 6 && v.slice(-3).every((x) => x > cap)
    const isSpike = (x: number, i: number): boolean => x > cap && !(sustained && i >= n - 3)
    const excluded = spending.months.filter((_, i) => isSpike(v[i] as number, i))
    const w = v.map((x, i) => (isSpike(x, i) ? cap : x))
    const base = med > 0 ? med : mean(w)
    const recent = median(w.slice(-3))
    const trend = recent > base * (1 + TREND_BAND) ? 'rising' : recent < base * (1 - TREND_BAND) ? 'falling' : 'flat'
    const raw = trend === 'flat' ? base : (base + recent) / 2
    const suggested = Math.ceil(Math.round(raw) / ROUND_UP_TO_CENTS) * ROUND_UP_TO_CENTS
    if (suggested <= 0) continue
    const existing = latestBudget.get(c.categoryId)?.amountCents ?? null
    const parts = [
      med > 0
        ? `Your median month in ${c.name} is ${formatCents(Math.round(med))}.`
        : `${c.name} is irregular (spend in ${active.length} of ${v.length} months); based on its average.`
    ]
    if (trend !== 'flat') {
      parts.push(
        `Recent months are ${trend === 'rising' ? 'higher' : 'lower'} (about ${formatCents(Math.round(recent))}), so the suggestion leans that way.`
      )
    }
    if (excluded.length > 0) {
      parts.push(`One-time large month(s) (${excluded.join(', ')}) were discounted.`)
    }
    parts.push(`Suggested: ${formatCents(suggested)} per month, rounded up to the next $5.`)
    out.push({
      categoryId: c.categoryId,
      name: c.name,
      suggestedCents: suggested,
      baseMedianCents: Math.round(med),
      trend,
      existingBudgetCents: existing,
      excludedOutlierMonths: excluded,
      rationale: parts.join(' ')
    })
  }
  return out
}
