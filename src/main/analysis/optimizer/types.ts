/** Plain, structured-clone-safe data types for the budget optimizer (instructions section 11). */

export interface OptTransaction {
  id: string
  /** ISO YYYY-MM-DD */
  date: string
  /** Integer cents, negative = expense. */
  amountCents: number
  /** Normalized merchant / description key (see merchantKey). */
  merchant: string
  categoryId: string | null
  isTransfer: boolean
}

export interface OptCategory {
  id: string
  name: string
  kind: 'expense' | 'income' | 'transfer'
}

export interface OptBudget {
  categoryId: string
  /** YYYY-MM */
  month: string
  amountCents: number
}

export type AnomalyReasonCode =
  | 'amount_outlier'
  | 'first_time_large'
  | 'duplicate_charge'
  | 'rapid_burst'
  | 'subscription_increase'

/** User marked a flag legitimate: similar future flags (same reason + merchant) are suppressed. */
export interface FlagSuppression {
  reasonCode: AnomalyReasonCode
  merchant: string
}

export interface OptimizerInput {
  /** Today's date (ISO). The current partial month is excluded from statistics. */
  today: string
  transactions: OptTransaction[]
  categories: OptCategory[]
  budgets: OptBudget[]
  /** Merchant keys the user rejected as subscriptions (remembered). */
  rejectedSubscriptions: string[]
  /** Merchant keys the user confirmed as subscriptions. */
  confirmedSubscriptions: string[]
  suppressions: FlagSuppression[]
}

export const MIN_MONTHS = 6
export const MAX_MONTHS = 12

export interface Eligibility {
  eligible: boolean
  requiredMonths: number
  availableMonths: number
  /** The months used (most recent <= 12 complete months), ascending YYYY-MM. */
  windowMonths: string[]
  message: string
}

export interface CategoryStat {
  categoryId: string | null
  name: string
  totalCents: number
  meanCents: number
  medianCents: number
  /** Fraction 0..1 of total spending (display only, never money math). */
  share: number
  monthlyCents: number[]
}

export interface SpendingSummary {
  months: string[]
  overall: { totalCents: number; meanCents: number; medianCents: number; monthlyCents: number[] }
  categories: CategoryStat[]
  highest: CategoryStat | null
}

export type Cadence = 'weekly' | 'monthly' | 'annual'

export interface PriceIncrease {
  fromCents: number
  toCents: number
  pct: number
}

export interface Subscription {
  merchant: string
  amountCents: number
  cadence: Cadence
  annualizedCents: number
  chargeCount: number
  firstDate: string
  lastDate: string
  nextExpected: string
  latestTransactionId: string
  categoryId: string | null
  priceIncrease: PriceIncrease | null
  /** No charge for well over one expected interval: possibly cancelled or unused. */
  lapsed: boolean
  status: 'detected' | 'confirmed'
}

export type Severity = 'low' | 'medium' | 'high'

export interface AnomalyFlag {
  transactionId: string
  reasonCode: AnomalyReasonCode
  severity: Severity
  /** Human-readable, neutral wording ("flag, never accuse"). */
  reason: string
  merchant: string
  date: string
  amountCents: number
}

export interface BudgetSuggestion {
  categoryId: string
  name: string
  suggestedCents: number
  baseMedianCents: number
  trend: 'rising' | 'falling' | 'flat'
  existingBudgetCents: number | null
  excludedOutlierMonths: string[]
  rationale: string
}

export type OptimizerResult =
  | { eligibility: Eligibility & { eligible: false } }
  | {
      eligibility: Eligibility & { eligible: true }
      spending: SpendingSummary
      subscriptions: Subscription[]
      flags: AnomalyFlag[]
      suggestedBudgets: BudgetSuggestion[]
    }

export function merchantKey(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, ' ')
}
