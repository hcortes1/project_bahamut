/**
 * Single source of truth for the renderer <-> main IPC contract.
 *
 * - `channels` is the channel table: name -> zod request schema (+ whether the channel is usable while
 *   the app is locked). Main registers a handler for every entry and validates every payload against
 *   `request`; the preload builds `window.flujo` from the same table.
 * - Response and DTO types are plain TypeScript (the renderer never needs to parse them again). The main
 *   handlers return values typed against them, so drift fails the typecheck.
 * - Every call resolves to `Result<T>`: `{ ok: true, data }` or `{ ok: false, error }`. Error messages
 *   are fixed strings; they never contain secrets, file contents or payload values.
 */
import { z } from 'zod'
import {
  AccountType,
  AggregateFilter,
  CategoryKind,
  InputCents,
  IsoDate,
  IsoMonth,
  NewAccount,
  NewCategory,
  type Account,
  type Budget,
  type Category,
  type CategorySpend,
  type ImportRecord,
  type MerchantSpend,
  type MonthlyTotals,
  type Transaction
} from './db-types'

// ------------------------------------------------------------------ results and errors

export interface IpcError {
  /** Stable machine-readable code (see KNOWN_ERROR_CODES; feature/pipeline codes pass through). */
  code: string
  /** Fixed, safe, human-readable text. */
  message: string
  /** Import errors only: base name of the file the user picked. */
  fileName?: string
  /** PDF errors only. */
  page?: number | null
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export const KNOWN_ERROR_CODES = [
  'LOCKED',
  'FORBIDDEN_SENDER',
  'INVALID_PAYLOAD',
  'NOT_FOUND',
  'CONFLICT',
  'INTERNAL',
  'CANCELLED',
  'TOO_MANY_OPEN_IMPORTS',
  'OPTIMIZER_FAILED'
] as const

// ------------------------------------------------------------------ request building blocks

const id = z.uuid()
const rowId = z.string().min(1).max(40)
const secret = z.string().max(1024)
const credentials = z.strictObject({ pin: secret.optional(), password: secret.optional() })
const dateRange = z.strictObject({ from: IsoDate, to: IsoDate, accountId: id.optional() }).refine((r) => r.from <= r.to, {
  message: 'from must be on or before to',
  path: ['to']
})
const safeCents = InputCents
const text = (max: number) => z.string().trim().min(1).max(max)

const Cadence = z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'])
const RecurringStatus = z.enum(['active', 'paused', 'cancelled'])
const noArgs = z.undefined()

const fieldOverride = z.strictObject({ index: z.number().int().min(0).max(1000).nullable() })
export const CsvMappingOverride = z.strictObject({
  hasHeader: z.boolean().optional(),
  date: fieldOverride.optional(),
  description: fieldOverride.optional(),
  amount: z
    .strictObject({
      mode: z.enum(['single', 'split']).optional(),
      amountIndex: z.number().int().min(0).max(1000).nullable().optional(),
      debitIndex: z.number().int().min(0).max(1000).nullable().optional(),
      creditIndex: z.number().int().min(0).max(1000).nullable().optional()
    })
    .optional(),
  dateOrder: z.enum(['MDY', 'DMY', 'YMD']).optional(),
  invertSign: z.boolean().optional()
})

const RowEdit = z.strictObject({
  date: IsoDate.optional(),
  amountCents: safeCents.optional(),
  description: z.string().max(2000).optional(),
  categoryId: id.optional()
})

export const SettingsPatch = z.strictObject({
  idleTimeoutMs: z.number().int().min(30_000).max(24 * 60 * 60_000).optional(),
  lockOnMinimize: z.boolean().optional(),
  retainImports: z.boolean().optional(),
  importConfidenceThreshold: z.number().min(0.05).max(1).optional()
})

// ------------------------------------------------------------------ channel table

export interface ChannelDef<Q extends z.ZodType, R> {
  readonly request: Q
  /** Usable while the session is locked. Everything else is rejected with LOCKED. */
  readonly public: boolean
  /** Phantom marker carrying the response type; never called. */
  __res(r: R): void
}

/** ch<ResponseType>()(requestSchema, { public? }) */
const ch =
  <R>() =>
  <Q extends z.ZodType>(request: Q, opts: { public?: boolean } = {}): ChannelDef<Q, R> =>
    ({ request, public: opts.public === true }) as ChannelDef<Q, R>

const idOnly = z.strictObject({ id })
const sessionOnly = z.strictObject({ sessionId: id })
const filter = AggregateFilter
const patchOf = <T extends z.ZodRawShape>(shape: T) => z.strictObject({ id, patch: z.strictObject(shape).partial() })

const listQuery = z.strictObject({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  accountId: id.optional(),
  categoryId: id.optional(),
  limit: z.number().int().min(1).max(2000).optional(),
  offset: z.number().int().min(0).optional()
})
const nonZero = safeCents.refine((n) => n !== 0, 'amount must not be zero')
const newRecurringShape = {
  name: text(200),
  amountCents: safeCents,
  cadence: Cadence,
  nextDue: IsoDate.nullable(),
  categoryId: id.nullable(),
  isSubscription: z.boolean(),
  status: RecurringStatus
}
const transferShape = {
  fromAccountId: id,
  toAccountId: id,
  date: IsoDate,
  amountCents: safeCents.min(1),
  description: text(500)
}

export const channels = {
  // auth (the only channels reachable while locked)
  'auth.status': ch<AuthStatusDto>()(noArgs, { public: true }),
  'auth.setup': ch<SetupOutcome>()(credentials, { public: true }),
  'auth.verify': ch<VerifyOutcome>()(credentials, { public: true }),
  'auth.forgot': ch<null>()(z.strictObject({ confirmWipe: z.literal(true) }), { public: true }),
  'auth.lock': ch<null>()(noArgs),
  'auth.changeCredential': ch<ChangeOutcome>()(
    z.strictObject({ current: credentials, kind: z.enum(['pin', 'password']), next: secret.nullable() })
  ),

  // settings
  'settings.get': ch<SettingsDto>()(noArgs),
  'settings.update': ch<SettingsDto>()(SettingsPatch),

  // accounts + balance snapshots
  'accounts.list': ch<Account[]>()(noArgs),
  'accounts.create': ch<Account>()(NewAccount),
  'accounts.update': ch<Account>()(patchOf({ name: NewAccount.shape.name, type: AccountType, institution: z.string().max(200).nullable(), last4: z.string().regex(/^d{4}$/).nullable() })),
  'accounts.delete': ch<boolean>()(idOnly),
  'accounts.recordBalance': ch<BalanceDto>()(z.strictObject({ accountId: id, date: IsoDate, balanceCents: safeCents })),
  'accounts.listBalances': ch<BalanceDto[]>()(z.strictObject({ accountId: id })),
  'accounts.deleteBalance': ch<boolean>()(idOnly),

  // transactions
  'transactions.list': ch<Transaction[]>()(listQuery),
  'transactions.create': ch<Transaction>()(
    z.strictObject({
      accountId: id,
      date: IsoDate,
      amountCents: nonZero,
      description: text(500),
      merchant: z.string().trim().max(200).nullable().optional(),
      categoryId: id.nullable().optional()
    })
  ),
  'transactions.update': ch<Transaction>()(
    patchOf({
      date: IsoDate,
      amountCents: nonZero,
      description: text(500),
      merchant: z.string().trim().max(200).nullable(),
      categoryId: id.nullable()
    })
  ),
  'transactions.delete': ch<boolean>()(idOnly),
  'transactions.createTransfer': ch<TransferDto>()(
    z.strictObject({ ...transferShape, description: transferShape.description.optional() })
  ),
  'transactions.updateTransfer': ch<TransferDto>()(
    z.strictObject({ linkId: id, patch: z.strictObject(transferShape).partial() })
  ),
  'transactions.deleteTransfer': ch<boolean>()(z.strictObject({ linkId: id })),

  // categories
  'categories.list': ch<Category[]>()(noArgs),
  'categories.create': ch<Category>()(NewCategory),
  'categories.update': ch<Category>()(patchOf({ name: NewCategory.shape.name, parentId: id.nullable(), kind: CategoryKind })),
  'categories.delete': ch<boolean>()(idOnly),

  // budgets
  'budgets.list': ch<Budget[]>()(z.strictObject({ month: IsoMonth.optional() })),
  'budgets.set': ch<Budget>()(z.strictObject({ categoryId: id, month: IsoMonth, amountCents: safeCents.nonnegative() })),
  'budgets.delete': ch<boolean>()(idOnly),
  'budgets.progress': ch<BudgetProgressDto>()(z.strictObject({ month: IsoMonth })),

  // imports (file picking and reading happen in main; the renderer never sees a path)
  'imports.list': ch<ImportRecord[]>()(noArgs),
  'imports.open': ch<OpenImportResult>()(z.strictObject({ accountId: id })),
  'imports.view': ch<ReviewViewDto>()(sessionOnly),
  'imports.setMapping': ch<ReviewViewDto>()(z.strictObject({ sessionId: id, mapping: CsvMappingOverride })),
  'imports.confirmMapping': ch<ReviewViewDto>()(sessionOnly),
  'imports.acknowledgeFileDuplicate': ch<ReviewViewDto>()(sessionOnly),
  'imports.editRow': ch<ReviewViewDto>()(z.strictObject({ sessionId: id, rowId, edit: RowEdit })),
  'imports.setExcluded': ch<ReviewViewDto>()(z.strictObject({ sessionId: id, rowId, excluded: z.boolean() })),
  'imports.confirmRow': ch<ReviewViewDto>()(z.strictObject({ sessionId: id, rowId })),
  'imports.bulkSetCategory': ch<ReviewViewDto>()(
    z.strictObject({ sessionId: id, rowIds: z.array(rowId).min(1).max(20_000), categoryId: id })
  ),
  'imports.resolveDuplicate': ch<ReviewViewDto>()(
    z.strictObject({
      sessionId: id,
      groupId: z.string().min(1).max(200),
      decision: z.enum(['skip', 'import']),
      applyToAllRemaining: z.boolean().optional()
    })
  ),
  'imports.blockers': ch<CommitBlockersDto>()(sessionOnly),
  'imports.commit': ch<CommitResultDto>()(z.strictObject({ sessionId: id, keepSourceFile: z.boolean().optional() })),
  'imports.discard': ch<null>()(sessionOnly),
  'imports.providePassword': ch<null>()(z.strictObject({ promptId: id, password: secret.nullable() })),
  'imports.deleteRetained': ch<DeleteRetainedDto>()(
    z.strictObject({ importId: id, alsoDeleteTransactions: z.boolean() })
  ),

  // dashboard
  'dashboard.spendingByMonth': ch<MonthSpendDto[]>()(filter),
  'dashboard.trend': ch<TrendDto>()(z.strictObject({ filter, window: z.number().int().min(2).max(12).optional() })),
  'dashboard.incomeVsExpenses': ch<IncomeExpenseDto[]>()(filter),
  'dashboard.byCategory': ch<CategorySpend[]>()(filter),
  'dashboard.topMerchants': ch<MerchantSpend[]>()(z.strictObject({ filter, limit: z.number().int().min(1).max(100).optional() })),
  'dashboard.drillDown': ch<Transaction[]>()(
    z.strictObject({
      filter,
      categoryId: id,
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional()
    })
  ),

  // recurring
  'recurring.list': ch<RecurringDto[]>()(z.strictObject({ status: RecurringStatus.optional() })),
  'recurring.create': ch<RecurringDto>()(
    z.strictObject({
      ...newRecurringShape,
      nextDue: newRecurringShape.nextDue.optional(),
      categoryId: newRecurringShape.categoryId.optional(),
      isSubscription: newRecurringShape.isSubscription.optional(),
      status: newRecurringShape.status.optional()
    })
  ),
  'recurring.update': ch<RecurringDto>()(patchOf(newRecurringShape)),
  'recurring.delete': ch<boolean>()(idOnly),
  'recurring.markPaid': ch<RecurringDto>()(idOnly),
  'recurring.dueSoon': ch<DueItemDto[]>()(z.strictObject({ withinDays: z.number().int().min(0).max(366).optional() })),

  // goals
  'goals.list': ch<GoalDto[]>()(noArgs),
  'goals.create': ch<GoalDto>()(
    z.strictObject({
      name: text(200),
      targetCents: z.number().int().min(1).max(1_000_000_000_000),
      targetDate: IsoDate.nullable().optional(),
      openingCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
      openingDate: IsoDate.optional()
    })
  ),
  'goals.update': ch<GoalDto>()(
    patchOf({ name: text(200), targetCents: z.number().int().min(1).max(1_000_000_000_000), targetDate: IsoDate.nullable() })
  ),
  'goals.delete': ch<boolean>()(idOnly),
  'goals.addContribution': ch<ContributionDto>()(z.strictObject({ goalId: id, date: IsoDate, amountCents: nonZero })),
  'goals.listContributions': ch<ContributionDto[]>()(z.strictObject({ goalId: id })),
  'goals.updateContribution': ch<ContributionDto>()(patchOf({ date: IsoDate, amountCents: nonZero })),
  'goals.deleteContribution': ch<boolean>()(idOnly),
  'goals.projection': ch<GoalProjectionDto>()(z.strictObject({ goalId: id })),

  // net worth
  'netWorth.current': ch<NetWorthPointDto>()(z.strictObject({ includeGoals: z.boolean().optional() })),
  'netWorth.history': ch<NetWorthMonthDto[]>()(
    z.strictObject({ fromMonth: IsoMonth, toMonth: IsoMonth, includeGoals: z.boolean().optional() })
  ),

  // optimizer
  'optimizer.run': ch<OptimizerResultDto>()(noArgs),
  'optimizer.listSubscriptions': ch<SubscriptionRecordDto[]>()(noArgs),
  'optimizer.confirmSubscription': ch<boolean>()(idOnly),
  'optimizer.rejectSubscription': ch<boolean>()(idOnly),
  'optimizer.listFlags': ch<FlagRecordDto[]>()(z.strictObject({ status: z.enum(['open', 'dismissed', 'confirmed']).optional() })),
  'optimizer.markFlagLegitimate': ch<boolean>()(idOnly),
  'optimizer.markFlagSuspicious': ch<boolean>()(idOnly),
  /** The amount comes from main's copy of the last optimizer run, never from the renderer. */
  'optimizer.acceptSuggestedBudget': ch<Budget>()(z.strictObject({ categoryId: id, month: IsoMonth })),

  // categorizer rules and learning
  'categorizer.listLearnedRules': ch<RuleDto[]>()(noArgs),
  'categorizer.editLearnedRule': ch<RuleDto>()(
    patchOf({ pattern: text(200), categoryId: id, weight: z.number().positive().max(1000) })
  ),
  'categorizer.deleteLearnedRule': ch<boolean>()(idOnly),
  'categorizer.recordCorrection': ch<CorrectionResultDto>()(z.strictObject({ transactionId: id, categoryId: id })),
  'categorizer.reapply': ch<{ changed: number }>()(
    z.strictObject({ transactionIds: z.array(id).min(1).max(10_000), categoryId: id })
  ),

  // export + data wipe
  'export.csv': ch<{ saved: boolean }>()(z.strictObject({ kind: z.enum(['transactions', 'summary']), range: dateRange })),
  'data.wipe': ch<WipeOutcome>()(z.strictObject({ current: credentials, confirmWipe: z.literal(true) }))
} as const

export type ChannelName = keyof typeof channels
export type ChannelRequest<K extends ChannelName> = z.input<(typeof channels)[K]['request']>
export type ChannelResponse<K extends ChannelName> = (typeof channels)[K] extends { __res(r: infer R): void } ? R : never

/** Channels reachable while locked. */
export const PUBLIC_CHANNELS: readonly ChannelName[] = (Object.keys(channels) as ChannelName[]).filter((k) => channels[k].public)

// ------------------------------------------------------------------ events (main -> renderer)

export const EVENT_LOCKED = 'session.locked'
export const EVENT_PASSWORD_PROMPT = 'imports.passwordPrompt'

export interface LockedEvent {
  reason: 'idle' | 'minimize' | 'manual'
}
export interface PasswordPromptEvent {
  /** Reply with imports.providePassword({ promptId, password | null }). */
  promptId: string
  fileName: string
  attempt: number
  reason: 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT'
}

// ------------------------------------------------------------------ the renderer API

type Method<K extends ChannelName> = [ChannelRequest<K>] extends [undefined]
  ? () => Promise<Result<ChannelResponse<K>>>
  : (req: ChannelRequest<K>) => Promise<Result<ChannelResponse<K>>>

type GroupOf<K extends string> = K extends `${infer G}.${string}` ? G : never
type MethodOf<K extends string, G extends string> = K extends `${G}.${infer M}` ? M : never

export type ChannelGroups = {
  [G in GroupOf<ChannelName>]: {
    [K in ChannelName as MethodOf<K, G>]: Method<K>
  }
}

export type FlujoApi = ChannelGroups & {
  readonly appName: 'Flujo'
  readonly on: {
    /** The session locked (idle, minimize or manual). Clear all sensitive renderer state. Returns unsubscribe. */
    locked(cb: (e: LockedEvent) => void): () => void
    /** A protected PDF needs a password. Answer with imports.providePassword. Returns unsubscribe. */
    passwordPrompt(cb: (e: PasswordPromptEvent) => void): () => void
  }
}

// ------------------------------------------------------------------ DTOs

export interface AuthStatusDto {
  configured: boolean
  pinEnabled: boolean
  passwordEnabled: boolean
  /** Epoch ms when the lockout ends, 0 when not locked out. */
  lockedOutUntil: number
  /** True when the app is locked (the renderer must show the lock/setup screen). */
  locked: boolean
}
export type SetupOutcome = { done: true } | { done: false; reason: 'already_configured' | 'no_credential' | 'invalid_format' }
export type VerifyOutcome =
  | { unlocked: true }
  | { unlocked: false; reason: 'not_configured' | 'invalid_input' }
  | { unlocked: false; reason: 'locked'; retryAfterMs: number }
  | { unlocked: false; reason: 'invalid'; failureCount: number; retryAfterMs: number }
export type ChangeOutcome =
  | { changed: true }
  | { changed: false; reason: 'invalid_format' | 'would_remove_last_credential' | 'not_enabled' | 'not_configured' | 'invalid_input' | 'locked' | 'invalid'; retryAfterMs?: number }
export type WipeOutcome = { wiped: true } | { wiped: false; reason: 'locked' | 'invalid' | 'not_configured' | 'invalid_input'; retryAfterMs?: number }

export interface SettingsDto {
  idleTimeoutMs: number
  lockOnMinimize: boolean
  retainImports: boolean
  importConfidenceThreshold: number
}

export interface BalanceDto {
  id: string
  accountId: string
  date: string
  balanceCents: number
}
export interface TransferDto {
  linkId: string
  date: string
  amountCents: number
  description: string
  fromAccountId: string
  toAccountId: string
  outLegId: string
  inLegId: string
}

export interface BudgetProgressItemDto {
  categoryId: string
  categoryName: string
  budgetCents: number
  spentCents: number
  remainingCents: number
  percentUsed: number | null
  overBudget: boolean
  expectedByNowCents: number | null
  overPace: boolean | null
}
export interface BudgetProgressDto {
  month: string
  phase: 'past' | 'current' | 'future'
  partial: boolean
  label: string
  elapsedDays: number
  daysInMonth: number
  items: BudgetProgressItemDto[]
  totalBudgetCents: number
  totalSpentCents: number
  unbudgeted: { categoryId: string | null; categoryName: string; spentCents: number }[]
}

// ---- imports / review

export interface SkippedCountsDto {
  blank: number
  summary: number
  invalid: number
  total: number
}
export interface FieldDetectionDto {
  index: number | null
  confidence: number
}
export interface CsvMappingDto {
  hasHeader: boolean
  headerRowIndex: number
  date: FieldDetectionDto
  description: FieldDetectionDto
  amount: {
    mode: 'single' | 'split'
    amountIndex: number | null
    debitIndex: number | null
    creditIndex: number | null
    confidence: number
  }
  dateOrder: 'MDY' | 'DMY' | 'YMD'
  dateOrderAmbiguous: boolean
  dateOrderConflict: boolean
  invertSign: boolean
}
export interface ReviewRowDto {
  id: string
  index: number
  source: 'pdf' | 'csv'
  date: string
  amountCents: number
  description: string
  descriptionNormalized: string
  categoryId: string
  confidence: number
  lowConfidence: boolean
  reviewed: boolean
  excluded: boolean
  edited: boolean
  fingerprint: string
  occurrence: number
  duplicateGroupId: string | null
  original: { date: string; amountCents: number; description: string }
}
export interface DuplicateGroupDto {
  id: string
  fingerprint: string
  decision: 'pending' | 'skip' | 'import'
  existing: {
    id: string
    date: string
    amountCents: number
    description: string
    importId: string | null
    source: 'pdf' | 'csv' | 'manual'
  }[]
  incomingRowIds: string[]
}
/** Snapshot of a main-process review session. No file bytes, no paths. */
export interface ReviewViewDto {
  id: string
  status: 'open' | 'committed' | 'discarded'
  accountId: string
  fileName: string
  fileType: 'pdf' | 'csv'
  fileHash: string
  threshold: number
  rows: ReviewRowDto[]
  duplicateGroups: DuplicateGroupDto[]
  overlap: {
    detected: boolean
    duplicateRowCount: number
    nearMatchCount: number
    overlappingImportIds: string[]
    dateRange: { from: string; to: string } | null
  }
  fileDuplicate: {
    existingImportId: string
    existingFileName: string
    existingImportedAt: string
    acknowledged: boolean
  } | null
  validation: {
    ok: boolean
    checked: boolean
    expectedEndingCents: number | null
    computedEndingCents: number | null
    differenceCents: number | null
  } | null
  csv: {
    mapping: CsvMappingDto
    headers: string[] | null
    delimiter: string
    encoding: string
    mappingConfidence: number
    skipped: SkippedCountsDto
    warnings: string[]
    needsConfirmation: boolean
    confirmed: boolean
  } | null
  pdf: {
    parserId: string
    accountType: string
    last4: string | null
    periodStart: string
    periodEnd: string
    statementConfidence: number
    warnings: { code: string; message: string; count?: number }[]
  } | null
}
export type OpenImportResult = { cancelled: true } | { cancelled: false; review: ReviewViewDto }
export interface CommitBlockersDto {
  codes: string[]
  lowConfidencePending: number
  duplicatesPending: number
}
export interface CommitResultDto {
  importId: string
  inserted: number
  skippedDuplicates: number
  excluded: number
  /** Whether a copy of the source file was kept (the path itself is never exposed). */
  retained: boolean
}
export interface DeleteRetainedDto {
  fileDeleted: boolean
  transactionsDeleted: number
}

// ---- dashboard
export interface MonthSpendDto {
  month: string
  expenseCents: number
  /** The in-progress current month: label it as partial. */
  partial: boolean
}
export interface IncomeExpenseDto extends MonthlyTotals {
  netCents: number
  partial: boolean
}
export interface TrendDto {
  window: number
  points: { month: string; expenseCents: number; trailingAverageCents: number; partial: boolean }[]
}

// ---- recurring / goals / net worth
export interface RecurringDto {
  id: string
  name: string
  amountCents: number
  cadence: string
  nextDue: string | null
  categoryId: string | null
  isSubscription: boolean
  status: string
}
export interface DueItemDto extends RecurringDto {
  daysUntilDue: number
  overdue: boolean
}
export interface GoalDto {
  id: string
  name: string
  targetCents: number
  targetDate: string | null
  currentCents: number
}
export interface ContributionDto {
  id: string
  goalId: string
  date: string
  amountCents: number
}
export interface GoalProjectionDto {
  goalId: string
  status: 'achieved' | 'projected' | 'insufficient_data' | 'no_progress' | 'too_far'
  remainingCents: number
  windowNetCents: number
  windowDays: number
  monthlyRateCents: number
  projectedDate: string | null
  targetDate: string | null
  onTrack: boolean | null
  requiredMonthlyCents: number | null
}
export interface NetWorthPointDto {
  asOf: string
  assetsCents: number
  liabilitiesCents: number
  goalsCents: number
  netWorthCents: number
  accountsWithoutSnapshot: string[]
}
export interface NetWorthMonthDto extends NetWorthPointDto {
  month: string
  partial: boolean
}

// ---- optimizer
export interface CategoryStatDto {
  categoryId: string | null
  name: string
  totalCents: number
  meanCents: number
  medianCents: number
  share: number
  monthlyCents: number[]
}
export interface SubscriptionDto {
  merchant: string
  amountCents: number
  cadence: 'weekly' | 'monthly' | 'annual'
  annualizedCents: number
  chargeCount: number
  firstDate: string
  lastDate: string
  nextExpected: string
  latestTransactionId: string
  categoryId: string | null
  priceIncrease: { fromCents: number; toCents: number; pct: number } | null
  lapsed: boolean
  status: 'detected' | 'confirmed'
}
export interface AnomalyFlagDto {
  transactionId: string
  reasonCode: string
  severity: 'low' | 'medium' | 'high'
  reason: string
  merchant: string
  date: string
  amountCents: number
}
export interface BudgetSuggestionDto {
  categoryId: string
  name: string
  suggestedCents: number
  baseMedianCents: number
  trend: 'rising' | 'falling' | 'flat'
  existingBudgetCents: number | null
  excludedOutlierMonths: string[]
  rationale: string
}
export interface EligibilityDto {
  eligible: boolean
  requiredMonths: number
  availableMonths: number
  windowMonths: string[]
  message: string
}
export type OptimizerResultDto =
  | { eligibility: EligibilityDto & { eligible: false } }
  | {
      eligibility: EligibilityDto & { eligible: true }
      spending: {
        months: string[]
        overall: { totalCents: number; meanCents: number; medianCents: number; monthlyCents: number[] }
        categories: CategoryStatDto[]
        highest: CategoryStatDto | null
      }
      subscriptions: SubscriptionDto[]
      flags: AnomalyFlagDto[]
      suggestedBudgets: BudgetSuggestionDto[]
    }
export interface SubscriptionRecordDto {
  id: string
  name: string
  amountCents: number
  cadence: string
  nextDue: string | null
  categoryId: string | null
  status: string
}
export interface FlagRecordDto {
  id: string
  transactionId: string
  reasonCode: string
  severity: string
  status: 'open' | 'dismissed' | 'confirmed'
  reason: string
  createdAt: string
}

// ---- categorizer
export interface RuleDto {
  id: string
  pattern: string
  categoryId: string
  source: 'system' | 'learned' | 'user'
  weight: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}
export interface CorrectionResultDto {
  rule: RuleDto
  created: boolean
  /** Other transactions from the same merchant: offer to re-apply with categorizer.reapply. */
  reapplyCandidates: Transaction[]
  shadowedByUserRule: RuleDto | null
}
