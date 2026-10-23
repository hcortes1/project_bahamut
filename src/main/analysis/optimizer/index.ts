import { detectAnomalies } from './anomalies'
import { suggestBudgets } from './budgets'
import { computeEligibility } from './months'
import { computeSpending } from './spending'
import { detectSubscriptions } from './subscriptions'
import type { OptimizerInput, OptimizerResult } from './types'

export * from './types'
export { computeEligibility } from './months'
export { computeSpending, isSpendingTx } from './spending'
export { detectSubscriptions } from './subscriptions'
export { detectAnomalies, suppressionKey, ANOMALY_CONFIG } from './anomalies'
export { suggestBudgets } from './budgets'
export { median, mean, quantile, scaledMad, robustZ } from './stats'

/** Pure entry point: no I/O, safe to run in a worker thread. */
export function runOptimizer(input: OptimizerInput): OptimizerResult {
  const eligibility = computeEligibility(input.transactions, input.today)
  if (!eligibility.eligible) return { eligibility: { ...eligibility, eligible: false } }
  const spending = computeSpending(input.transactions, input.categories, eligibility.windowMonths)
  const subscriptions = detectSubscriptions(
    input.transactions,
    input.categories,
    input.today,
    input.rejectedSubscriptions,
    input.confirmedSubscriptions
  )
  const first = eligibility.windowMonths[0] as string
  const flags = detectAnomalies(input.transactions, input.categories, {
    today: input.today,
    sinceDate: `${first}-01`,
    subscriptions,
    suppressions: input.suppressions
  })
  const suggestedBudgets = suggestBudgets(spending, input.budgets)
  return { eligibility: { ...eligibility, eligible: true }, spending, subscriptions, flags, suggestedBudgets }
}
