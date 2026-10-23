import { daysBetween } from '@shared/dates'
import { formatCents } from '@shared/money'
import { median, quantile, robustZ } from './stats'
import { categoryKinds, isSpendingTx } from './spending'
import type {
  AnomalyFlag,
  AnomalyReasonCode,
  FlagSuppression,
  OptCategory,
  OptTransaction,
  Severity,
  Subscription
} from './types'

export const ANOMALY_CONFIG = {
  /** Minimum charges at a merchant (or in a category) before an amount baseline is trusted. */
  minMerchantCharges: 5,
  minCategoryCharges: 10,
  zThreshold: 3.5,
  highZ: 6,
  minOutlierRatio: 1.5,
  minOutlierExtraCents: 2000,
  firstTimeMinHistoryDays: 60,
  firstTimeFloorCents: 20000,
  duplicateWindowDays: 2,
  duplicateMinCents: 500,
  duplicateNearPct: 0.05,
  burstDayTotal: 8,
  burstDayMerchant: 4
}

const NOTE = 'This may well be legitimate; mark it as legitimate if so.'

export const suppressionKey = (reasonCode: AnomalyReasonCode, merchant: string): string =>
  `${reasonCode}|${merchant}`

interface Opts {
  today: string
  /** Only flag transactions on/after this date (baselines still use all history). */
  sinceDate?: string
  subscriptions?: readonly Subscription[]
  suppressions?: readonly FlagSuppression[]
}

const SEV_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 }

export function detectAnomalies(
  txs: readonly OptTransaction[],
  cats: readonly OptCategory[],
  opts: Opts
): AnomalyFlag[] {
  const C = ANOMALY_CONFIG
  const kinds = categoryKinds(cats)
  const spend = txs
    .filter((t) => t.amountCents < 0 && t.merchant !== '' && t.date <= opts.today && isSpendingTx(t, kinds))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)))
  if (spend.length === 0) return []
  const subMerchants = new Set((opts.subscriptions ?? []).map((s) => s.merchant))
  const flags: AnomalyFlag[] = []
  const add = (t: OptTransaction, reasonCode: AnomalyReasonCode, severity: Severity, reason: string): void => {
    flags.push({
      transactionId: t.id,
      reasonCode,
      severity,
      reason,
      merchant: t.merchant,
      date: t.date,
      amountCents: -t.amountCents
    })
  }
  const amt = (t: OptTransaction): number => -t.amountCents

  const byMerchant = new Map<string, OptTransaction[]>()
  const byCategory = new Map<string, OptTransaction[]>()
  for (const t of spend) {
    const m = byMerchant.get(t.merchant) ?? []
    m.push(t)
    byMerchant.set(t.merchant, m)
    if (t.categoryId) {
      const c = byCategory.get(t.categoryId) ?? []
      c.push(t)
      byCategory.set(t.categoryId, c)
    }
  }

  // 1. Amount far outside the usual range (robust z-score: median and MAD).
  for (const t of spend) {
    if (subMerchants.has(t.merchant)) continue
    const mList = byMerchant.get(t.merchant) ?? []
    let base: OptTransaction[] | null = null
    let scope = ''
    if (mList.length >= C.minMerchantCharges) {
      base = mList
      scope = `at ${t.merchant}`
    } else if (t.categoryId && (byCategory.get(t.categoryId)?.length ?? 0) >= C.minCategoryCharges) {
      base = byCategory.get(t.categoryId) ?? null
      scope = 'in this category'
    }
    if (!base) continue
    const values = base.map(amt)
    const med = median(values)
    const z = robustZ(amt(t), values, Math.max(med * 0.05, 100))
    if (z >= C.zThreshold && amt(t) >= med * C.minOutlierRatio && amt(t) - med >= C.minOutlierExtraCents) {
      add(
        t,
        'amount_outlier',
        z >= C.highZ ? 'high' : 'medium',
        `Worth a look: ${formatCents(amt(t))} at ${t.merchant} is well above the usual amount ${scope} ` +
          `(typically about ${formatCents(Math.round(med))}). ${NOTE}`
      )
    }
  }

  // 2. First-time merchant combined with a large amount.
  const amounts = spend.map(amt)
  const iqr = quantile(amounts, 0.75) - quantile(amounts, 0.25)
  const largeThreshold = Math.max(C.firstTimeFloorCents, Math.round(quantile(amounts, 0.75) + 3 * iqr))
  const dataStart = (spend[0] as OptTransaction).date
  for (const [merchant, list] of byMerchant) {
    const first = list[0] as OptTransaction
    if (daysBetween(dataStart, first.date) < C.firstTimeMinHistoryDays) continue
    if (amt(first) >= largeThreshold) {
      add(
        first,
        'first_time_large',
        amt(first) >= largeThreshold * 2 ? 'high' : 'medium',
        `Worth a look: ${merchant} has no earlier charges in your history and this one is ` +
          `${formatCents(amt(first))}, which is large compared with your usual spending. ${NOTE}`
      )
    }
  }

  // 3. Duplicate or near-duplicate charges from the same merchant in a short window.
  for (const [merchant, list] of byMerchant) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1] as OptTransaction
      const cur = list[i] as OptTransaction
      const gap = daysBetween(prev.date, cur.date)
      const hi = Math.max(amt(prev), amt(cur))
      if (gap > C.duplicateWindowDays || hi < C.duplicateMinCents) continue
      const exact = amt(prev) === amt(cur)
      const near = Math.abs(amt(prev) - amt(cur)) <= hi * C.duplicateNearPct
      if (!exact && !near) continue
      add(
        cur,
        'duplicate_charge',
        exact && gap === 0 ? 'medium' : 'low',
        `Worth a look: ${merchant} charged ${formatCents(amt(cur))} ${gap === 0 ? 'on the same day as' : `${gap} day(s) after`} ` +
          `a ${exact ? 'matching' : 'very similar'} charge of ${formatCents(amt(prev))}. ${NOTE}`
      )
    }
  }

  // 4. Rapid bursts of charges.
  const byDay = new Map<string, OptTransaction[]>()
  for (const t of spend) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t])
  for (const [date, list] of byDay) {
    if (list.length >= C.burstDayTotal) {
      add(
        list[list.length - 1] as OptTransaction,
        'rapid_burst',
        'low',
        `Worth a look: ${list.length} charges posted on ${date}, which is a lot for one day. ${NOTE}`
      )
    }
    const perMerchant = new Map<string, OptTransaction[]>()
    for (const t of list) perMerchant.set(t.merchant, [...(perMerchant.get(t.merchant) ?? []), t])
    for (const [merchant, ml] of perMerchant) {
      if (ml.length >= C.burstDayMerchant) {
        add(
          ml[ml.length - 1] as OptTransaction,
          'rapid_burst',
          'medium',
          `Worth a look: ${ml.length} charges from ${merchant} posted on ${date}. ${NOTE}`
        )
      }
    }
  }

  // 5. Unexpected increase in a known subscription amount.
  const byId = new Map(spend.map((t) => [t.id, t]))
  for (const s of opts.subscriptions ?? []) {
    if (!s.priceIncrease) continue
    const t = byId.get(s.latestTransactionId)
    if (!t) continue
    const pct = Math.round(s.priceIncrease.pct * 100)
    add(
      t,
      'subscription_increase',
      s.priceIncrease.pct >= 0.25 ? 'medium' : 'low',
      `Worth a look: the ${s.cadence} ${s.merchant} charge went from ${formatCents(s.priceIncrease.fromCents)} ` +
        `to ${formatCents(s.priceIncrease.toCents)} (+${pct}%). Price changes are common; ${NOTE}`
    )
  }

  // Filter: window, suppressions; keep one flag per (transaction, reason) at the highest severity.
  const suppressed = new Set((opts.suppressions ?? []).map((s) => suppressionKey(s.reasonCode, s.merchant)))
  const best = new Map<string, AnomalyFlag>()
  for (const f of flags) {
    if (opts.sinceDate && f.date < opts.sinceDate) continue
    if (suppressed.has(suppressionKey(f.reasonCode, f.merchant))) continue
    const k = `${f.transactionId}|${f.reasonCode}`
    const cur = best.get(k)
    if (!cur || SEV_RANK[f.severity] > SEV_RANK[cur.severity]) best.set(k, f)
  }
  return [...best.values()].sort(
    (a, b) =>
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      a.transactionId.localeCompare(b.transactionId)
  )
}

