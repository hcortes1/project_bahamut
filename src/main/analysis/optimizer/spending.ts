import { UNCATEGORIZED_CATEGORY_ID } from '../../db/system-categories'
import { mean, median, roundCents, sum } from './stats'
import { monthOf } from './months'
import type { CategoryStat, OptCategory, OptTransaction, SpendingSummary } from './types'

const UNCAT = '__uncategorized__'

export function categoryKinds(cats: readonly OptCategory[]): Map<string, OptCategory['kind']> {
  return new Map(cats.map((c) => [c.id, c.kind]))
}

/**
 * Counts toward spending (same rule as the dashboard SQL aggregates): not a transfer and not in an
 * income-kind category, whatever the sign. Positive amounts are refunds and net against their own
 * category; positive uncategorized amounts net against Uncategorized. Income-kind rows (including
 * negative reversals) never touch spending.
 */
export function isSpendingTx(t: OptTransaction, kinds: Map<string, OptCategory['kind']>): boolean {
  if (t.isTransfer) return false
  if (t.categoryId === null) return true
  const k = kinds.get(t.categoryId)
  return k !== 'income' && k !== 'transfer'
}

export function computeSpending(
  txs: readonly OptTransaction[],
  cats: readonly OptCategory[],
  months: readonly string[]
): SpendingSummary {
  const kinds = categoryKinds(cats)
  const names = new Map(cats.map((c) => [c.id, c.name]))
  const idx = new Map(months.map((m, i) => [m, i]))
  const perCat = new Map<string, number[]>()
  for (const t of txs) {
    const i = idx.get(monthOf(t.date))
    if (i === undefined || !isSpendingTx(t, kinds)) continue
    const key = t.categoryId === null || t.categoryId === UNCATEGORIZED_CATEGORY_ID ? UNCAT : t.categoryId
    let arr = perCat.get(key)
    if (!arr) perCat.set(key, (arr = months.map(() => 0)))
    arr[i] = (arr[i] as number) - t.amountCents
  }
  const monthly = months.map((_, i) => sum([...perCat.values()].map((a) => a[i] as number)))
  const total = sum(monthly)
  const categories: CategoryStat[] = [...perCat.entries()].map(([key, arr]) => {
    const t = sum(arr)
    return {
      categoryId: key === UNCAT ? null : key,
      name: key === UNCAT ? 'Uncategorized' : (names.get(key) ?? 'Unknown'),
      totalCents: t,
      meanCents: roundCents(mean(arr)),
      medianCents: roundCents(median(arr)),
      share: total > 0 ? t / total : 0,
      monthlyCents: arr
    }
  })
  categories.sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name))
  const top = categories[0]
  return {
    months: [...months],
    overall: {
      totalCents: total,
      meanCents: roundCents(mean(monthly)),
      medianCents: roundCents(median(monthly)),
      monthlyCents: monthly
    },
    categories,
    highest: top && top.totalCents > 0 ? top : null
  }
}
