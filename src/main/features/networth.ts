/**
 * Net worth (derived, never stored; instructions sections 5 and 9.5).
 *
 * FORMULA for a date D (the "as-of" date):
 *   assets      = sum of balance_cents of the latest snapshot (date <= D) of every
 *                 live checking/savings account
 *   liabilities = sum of balance_cents of the latest snapshot (date <= D) of every
 *                 live credit_card account. Credit-card snapshots hold the
 *                 amount OWED as a positive number, so a card with 1,200.00 owed
 *                 subtracts 1,200.00. A negative card snapshot (credit balance)
 *                 therefore adds to net worth.
 *   goals       = sum of live savings-goal contributions dated <= D. For "today"
 *                 this equals SUM(savings_goals.current_cents); history uses the
 *                 contribution dates so past months are not rewritten.
 *   netWorth    = assets - liabilities + goals
 *
 * Accounts with no snapshot on or before D contribute 0 and are listed in
 * `accountsWithoutSnapshot`. Note: if a goal's money also sits inside a savings
 * account balance it is counted twice; pass includeGoals=false to opt out.
 *
 * Historical series: one point per calendar month, evaluated at month end. The
 * month that contains `today` is evaluated at `today` and flagged `partial`;
 * months after today are not returned.
 */
import { z } from 'zod'
import type { Db } from '../db/connection'
import { goalsCurrentTotal, goalsTotalAsOf, latestBalancesAsOf } from '../db/features-repo'
import { FeatureError, ValidDate, ValidMonth, firstOfMonth, lastOfMonth, monthOf, nextMonth } from './common'

export interface NetWorthPoint {
  asOf: string
  assetsCents: number
  liabilitiesCents: number
  goalsCents: number
  netWorthCents: number
  accountsWithoutSnapshot: string[]
}
export interface NetWorthMonth extends NetWorthPoint {
  month: string
  /** True for the in-progress current month (evaluated at today, not month end). */
  partial: boolean
}

export function netWorthAsOf(db: Db, asOf: string, opts: { includeGoals?: boolean; useCurrentGoals?: boolean } = {}): NetWorthPoint {
  const d = ValidDate.parse(asOf)
  const includeGoals = opts.includeGoals ?? true
  let assets = 0
  let liabilities = 0
  const missing: string[] = []
  for (const b of latestBalancesAsOf(db, d)) {
    if (b.balanceCents === null) missing.push(b.accountId)
    else if (b.accountType === 'credit_card') liabilities += b.balanceCents
    else assets += b.balanceCents
  }
  const goals = !includeGoals ? 0 : opts.useCurrentGoals ? goalsCurrentTotal(db) : goalsTotalAsOf(db, d)
  return {
    asOf: d,
    assetsCents: assets,
    liabilitiesCents: liabilities,
    goalsCents: goals,
    netWorthCents: assets - liabilities + goals,
    accountsWithoutSnapshot: missing
  }
}

/** Net worth right now (goals taken from savings_goals.current_cents). */
export function currentNetWorth(db: Db, today: string, includeGoals = true): NetWorthPoint {
  return netWorthAsOf(db, today, { includeGoals, useCurrentGoals: true })
}

const HistoryQuery = z.object({ fromMonth: ValidMonth, toMonth: ValidMonth, today: ValidDate })

/** Month-end net worth series from fromMonth through min(toMonth, month of today). */
export function netWorthHistory(
  db: Db,
  query: z.input<typeof HistoryQuery> & { includeGoals?: boolean }
): NetWorthMonth[] {
  const q = HistoryQuery.parse(query)
  if (q.fromMonth > q.toMonth) throw new FeatureError('INVALID_RANGE')
  const out: NetWorthMonth[] = []
  const lastMonth = q.toMonth < monthOf(q.today) ? q.toMonth : monthOf(q.today)
  for (let m = q.fromMonth; m <= lastMonth; m = nextMonth(m)) {
    const end = lastOfMonth(m)
    const partial = end > q.today
    const asOf = partial ? q.today : end
    if (asOf < firstOfMonth(m)) break
    out.push({ month: m, partial, ...netWorthAsOf(db, asOf, { includeGoals: query.includeGoals }) })
  }
  return out
}
