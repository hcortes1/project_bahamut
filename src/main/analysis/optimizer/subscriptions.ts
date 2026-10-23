import { addDays, daysBetween, daysInMonth, toIsoDate } from '@shared/dates'
import { median } from './stats'
import { categoryKinds, isSpendingTx } from './spending'
import type { Cadence, OptCategory, OptTransaction, PriceIncrease, Subscription } from './types'

interface CadenceSpec {
  minDays: number
  maxDays: number
  minCharges: number
  perYear: number
  graceDays: number
}

/** Interval windows allow a few days of tolerance (weekends, posting delays). */
const CADENCES: Record<Cadence, CadenceSpec> = {
  weekly: { minDays: 5, maxDays: 9, minCharges: 4, perYear: 52, graceDays: 7 },
  monthly: { minDays: 26, maxDays: 35, minCharges: 3, perYear: 12, graceDays: 15 },
  annual: { minDays: 357, maxDays: 374, minCharges: 2, perYear: 1, graceDays: 30 }
}

const AMOUNT_BAND = 0.1 // near-constant: within 10% of the median (or of each side of one price step)
const INCREASE_MIN_PCT = 0.03
const INCREASE_MIN_CENTS = 50
const INTERVAL_SHARE = 0.75

function addMonths(iso: string, months: number): string {
  const y = Number(iso.slice(0, 4))
  const m = Number(iso.slice(5, 7)) - 1
  const d = Number(iso.slice(8, 10))
  const total = y * 12 + m + months
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return toIsoDate(ny, nm, Math.min(d, daysInMonth(ny, nm)))
}

function classify(intervals: number[]): Cadence | null {
  if (intervals.length === 0) return null
  const med = median(intervals)
  for (const [name, spec] of Object.entries(CADENCES) as [Cadence, CadenceSpec][]) {
    if (med < spec.minDays || med > spec.maxDays) continue
    const ok = intervals.filter((d) => d >= spec.minDays && d <= spec.maxDays).length
    if (ok / intervals.length >= INTERVAL_SHARE) return name
  }
  return null
}

const within = (v: number[]): boolean => {
  const med = median(v)
  return v.every((a) => Math.abs(a - med) <= med * AMOUNT_BAND)
}

/** Constant amounts, allowing at most one price step (so a price increase is still a subscription). */
function nearConstant(amounts: number[]): boolean {
  if (within(amounts)) return true
  for (let k = 1; k < amounts.length; k++) {
    if (within(amounts.slice(0, k)) && within(amounts.slice(k))) return true
  }
  return false
}

function detectPriceIncrease(amounts: number[]): PriceIncrease | null {
  const latest = amounts[amounts.length - 1] as number
  let j = amounts.length - 2
  while (j >= 0 && Math.abs((amounts[j] as number) - latest) / latest <= INCREASE_MIN_PCT) j--
  if (j < 0) return null
  const atLatest = amounts.length - 1 - j
  const prev = amounts[j] as number
  // Only a recent change (at most 3 charges at the new price) is worth surfacing.
  if (atLatest > 3 || latest <= prev * (1 + INCREASE_MIN_PCT) || latest - prev < INCREASE_MIN_CENTS) return null
  return { fromCents: prev, toCents: latest, pct: (latest - prev) / prev }
}

export function detectSubscriptions(
  txs: readonly OptTransaction[],
  cats: readonly OptCategory[],
  today: string,
  rejected: readonly string[] = [],
  confirmed: readonly string[] = []
): Subscription[] {
  const kinds = categoryKinds(cats)
  const rej = new Set(rejected)
  const conf = new Set(confirmed)
  const groups = new Map<string, OptTransaction[]>()
  for (const t of txs) {
    if (t.amountCents >= 0 || t.merchant === '' || !isSpendingTx(t, kinds)) continue
    if (t.date > today) continue
    let g = groups.get(t.merchant)
    if (!g) groups.set(t.merchant, (g = []))
    g.push(t)
  }
  const out: Subscription[] = []
  for (const [merchant, list] of groups) {
    if (rej.has(merchant)) continue
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)))
    const intervals: number[] = []
    for (let i = 1; i < list.length; i++) {
      const gap = daysBetween((list[i - 1] as OptTransaction).date, (list[i] as OptTransaction).date)
      if (gap > 0) intervals.push(gap) // same-day repeats are duplicates, not cadence
    }
    const cadence = classify(intervals)
    if (!cadence) continue
    const spec = CADENCES[cadence]
    if (list.length < spec.minCharges) continue
    const amounts = list.map((t) => -t.amountCents)
    if (!nearConstant(amounts)) continue
    const last = list[list.length - 1] as OptTransaction
    const first = list[0] as OptTransaction
    const amount = -last.amountCents
    const nextExpected =
      cadence === 'weekly' ? addDays(last.date, 7) : addMonths(last.date, cadence === 'monthly' ? 1 : 12)
    out.push({
      merchant,
      amountCents: amount,
      cadence,
      annualizedCents: amount * spec.perYear,
      chargeCount: list.length,
      firstDate: first.date,
      lastDate: last.date,
      nextExpected,
      latestTransactionId: last.id,
      categoryId: last.categoryId,
      priceIncrease: detectPriceIncrease(amounts),
      lapsed: daysBetween(nextExpected, today) > spec.graceDays,
      status: conf.has(merchant) ? 'confirmed' : 'detected'
    })
  }
  out.sort((a, b) => b.annualizedCents - a.annualizedCents || a.merchant.localeCompare(b.merchant))
  return out
}
