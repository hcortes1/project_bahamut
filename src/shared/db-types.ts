import { z } from 'zod'
import { isIsoDate } from './dates'

/** Upper bound on any single stored amount: $10 billion in cents. Keeps sums below 2^53. */
export const MAX_CENTS = 1_000_000_000_000
/** Integer cents (outputs and aggregates). Never floats. */
export const Cents = z.number().int()
/** Integer cents accepted on input: bounded so sums of many rows stay exact. */
export const InputCents = z.number().int().min(-MAX_CENTS).max(MAX_CENTS)
/** ISO calendar date YYYY-MM-DD that exists on the calendar. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isIsoDate, 'must be a real calendar date')
/** Budget month YYYY-MM (01-12). */
export const IsoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
/** UUID primary key reference (input side). */
export const Uuid = z.uuid()
/** UTC ISO timestamp. */
export const IsoTimestamp = z.string()

const audit = {
  id: z.string(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
  deletedAt: IsoTimestamp.nullable()
}

export const AccountType = z.enum(['checking', 'savings', 'credit_card'])
export const NewAccount = z.object({
  name: z.string().min(1).max(200),
  type: AccountType,
  institution: z.string().max(200).nullable().default(null),
  last4: z
    .string()
    .regex(/^\d{4}$/)
    .nullable()
    .default(null)
})
export const Account = NewAccount.extend(audit)
export type NewAccountInput = z.input<typeof NewAccount>
export type Account = z.infer<typeof Account>

export const CategoryKind = z.enum(['expense', 'income', 'transfer'])
export const NewCategory = z.object({
  name: z.string().min(1).max(100),
  parentId: Uuid.nullable().default(null),
  kind: CategoryKind.default('expense')
})
export const Category = NewCategory.extend({ ...audit, isSystem: z.boolean() })
export type NewCategoryInput = z.input<typeof NewCategory>
export type Category = z.infer<typeof Category>

export const TxSource = z.enum(['pdf', 'csv', 'manual'])
export const NewTransaction = z.object({
  accountId: Uuid,
  date: IsoDate,
  amountCents: InputCents,
  descriptionRaw: z.string().max(2000),
  descriptionNormalized: z.string().max(2000).nullable().default(null),
  merchant: z.string().max(500).nullable().default(null),
  categoryId: Uuid.nullable().default(null),
  importId: Uuid.nullable().default(null),
  fingerprint: z.string().max(200).nullable().default(null),
  source: TxSource.default('manual'),
  confidence: z.number().min(0).max(1).nullable().default(null),
  /**
   * Explicit transfer flag. Effective value is true when the category kind is 'transfer' or a
   * transfer link is set; on update it is re-derived whenever the category changes.
   */
  isTransfer: z.boolean().default(false),
  /** Shared by the two legs of a transfer created through the transfer APIs. */
  transferLinkId: Uuid.nullable().default(null)
})
export const Transaction = NewTransaction.extend({ ...audit, transferLinkId: z.string().nullable() })
export type NewTransactionInput = z.input<typeof NewTransaction>
export type Transaction = z.infer<typeof Transaction>

/**
 * Patch schema. Deliberately not NewTransaction.partial(): zod 4 applies .default() values inside
 * optional fields, which would silently reset omitted fields on update.
 */
export const TransactionPatch = z.object({
  date: IsoDate.optional(),
  amountCents: InputCents.optional(),
  descriptionRaw: z.string().max(2000).optional(),
  descriptionNormalized: z.string().max(2000).nullable().optional(),
  merchant: z.string().max(500).nullable().optional(),
  categoryId: Uuid.nullable().optional(),
  importId: Uuid.nullable().optional(),
  fingerprint: z.string().max(200).nullable().optional(),
  source: TxSource.optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  isTransfer: z.boolean().optional()
})
export type TransactionPatchInput = z.input<typeof TransactionPatch>

export const NewBudget = z.object({
  categoryId: Uuid,
  month: IsoMonth,
  amountCents: InputCents.nonnegative()
})
export const Budget = NewBudget.extend({ ...audit, categoryId: z.string() })
export type Budget = z.infer<typeof Budget>

export const NewImport = z.object({
  fileName: z.string().min(1).max(1000),
  fileType: z.enum(['pdf', 'csv']),
  fileHash: z.string().min(1).max(200),
  importedAt: IsoTimestamp.optional(),
  rowCount: z.number().int().nonnegative().default(0),
  retainedFilePath: z.string().max(2000).nullable().default(null)
})
export const ImportRecord = NewImport.extend({ ...audit, importedAt: IsoTimestamp })
export type NewImportInput = z.input<typeof NewImport>
export type ImportRecord = z.infer<typeof ImportRecord>

export const Setting = z.object({ key: z.string(), value: z.string(), updatedAt: IsoTimestamp })
export type Setting = z.infer<typeof Setting>

/** Filter shared by all dashboard aggregates. Dates inclusive; from must be <= to. */
export const AggregateFilter = z
  .object({
    from: IsoDate,
    to: IsoDate,
    accountId: Uuid.optional()
  })
  .refine((f) => f.from <= f.to, { message: 'from must be on or before to', path: ['to'] })
export type AggregateFilter = z.infer<typeof AggregateFilter>

/** Page size bounds for list queries. */
export const MAX_PAGE_SIZE = 10_000
export const PageLimit = z.number().int().min(1).max(MAX_PAGE_SIZE)

export const MonthlyTotals = z.object({
  month: IsoMonth,
  /** Net income: SUM(amount) over income-kind categories (income reversals net against it). */
  incomeCents: Cents,
  /**
   * Net spending: negated SUM(amount) over expense-kind (and uncategorized) rows, so refunds net
   * against it. Can be negative in a month where refunds exceed purchases.
   */
  expenseCents: Cents
})
export type MonthlyTotals = z.infer<typeof MonthlyTotals>

export const CategorySpend = z.object({
  /** Uncategorized rows (NULL category) are reported as the Uncategorized system category. */
  categoryId: z.string().nullable(),
  categoryName: z.string(),
  /** Net of refunds; may be negative. */
  expenseCents: Cents
})
export type CategorySpend = z.infer<typeof CategorySpend>

export const MerchantSpend = z.object({
  merchant: z.string(),
  expenseCents: Cents,
  count: z.number().int()
})
export type MerchantSpend = z.infer<typeof MerchantSpend>
