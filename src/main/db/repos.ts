import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  Account,
  AggregateFilter,
  Budget,
  Category,
  MAX_PAGE_SIZE,
  PageLimit,
  CategorySpend,
  ImportRecord,
  MerchantSpend,
  MonthlyTotals,
  NewAccount,
  NewBudget,
  NewCategory,
  NewImport,
  NewTransaction,
  Setting,
  Transaction,
  TransactionPatch,
  type NewAccountInput,
  type NewCategoryInput,
  type NewImportInput,
  type NewTransactionInput,
  type TransactionPatchInput
} from '@shared/db-types'
import type { Db } from './connection'
import { DbError } from './errors'
import { UNCATEGORIZED_CATEGORY_ID } from './system-categories'

const now = (): string => new Date().toISOString()

const camel = (k: string): string => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** snake_case row -> camelCase object; 0/1 `is_*` columns become booleans. Result is zod-validated by callers. */
function mapRow(row: unknown): unknown {
  if (row === undefined || row === null) return row
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[camel(k)] = k.startsWith('is_') && (v === 0 || v === 1) ? v === 1 : v
  }
  return out
}

function parseOne<T extends z.ZodType>(schema: T, row: unknown): z.infer<T> | undefined {
  return row === undefined ? undefined : schema.parse(mapRow(row))
}
function parseAll<T extends z.ZodType>(schema: T, rows: unknown[]): z.infer<T>[] {
  return rows.map((r) => schema.parse(mapRow(r)))
}

/** Convert camelCase params to a named-param object with SQLite-safe values. */
function toParams(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v
  }
  return out
}

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())

/** Generic soft delete: sets deleted_at; returns true if a live row was deleted. */
function softDelete(db: Db, table: string, id: string): boolean {
  const t = now()
  return (
    db
      .prepare(`UPDATE ${table} SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL`)
      .run(t, t, id).changes > 0
  )
}

/** Reject writes that reference a missing or soft-deleted account. */
export function assertLiveAccount(db: Db, id: string): void {
  if (!db.prepare('SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL').get(id)) {
    throw new DbError('ACCOUNT_NOT_FOUND')
  }
}
/** Reject writes that reference a missing or soft-deleted category. */
export function assertLiveCategory(db: Db, id: string): void {
  if (!db.prepare('SELECT 1 FROM categories WHERE id=? AND deleted_at IS NULL').get(id)) {
    throw new DbError('CATEGORY_NOT_FOUND')
  }
}
const categoryKind = (db: Db, id: string | null | undefined): string | null =>
  id ? ((db.prepare('SELECT kind FROM categories WHERE id=?').get(id) as { kind: string } | undefined)?.kind ?? null) : null

// ---------------------------------------------------------------- accounts
export function createAccount(db: Db, input: NewAccountInput): Account {
  const v = NewAccount.parse(input)
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO accounts (id,name,type,institution,last4,created_at,updated_at)
     VALUES (@id,@name,@type,@institution,@last4,@t,@t)`
  ).run({ ...v, id, t })
  return getAccount(db, id) as Account
}
export function getAccount(db: Db, id: string, includeDeleted = false): Account | undefined {
  const sql = `SELECT * FROM accounts WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`
  return parseOne(Account, db.prepare(sql).get(id))
}
export function listAccounts(db: Db): Account[] {
  return parseAll(
    Account,
    db.prepare('SELECT * FROM accounts WHERE deleted_at IS NULL ORDER BY name').all()
  )
}
export function updateAccount(
  db: Db,
  id: string,
  patch: Partial<NewAccountInput>
): Account | undefined {
  const cur = getAccount(db, id)
  if (!cur) return undefined
  const v = NewAccount.parse({ ...cur, ...patch })
  db.prepare(
    `UPDATE accounts SET name=@name,type=@type,institution=@institution,last4=@last4,updated_at=@t WHERE id=@id`
  ).run({ ...v, id, t: now() })
  return getAccount(db, id)
}
/**
 * Soft-deletes the account together with its transactions, balance snapshots and their anomaly
 * flags, in one SQLite transaction. The sibling leg of a transfer on another account is kept (it is
 * excluded from every total anyway).
 */
export function deleteAccount(db: Db, id: string): boolean {
  return db.transaction(() => {
    if (!softDelete(db, 'accounts', id)) return false
    const t = now()
    db.prepare(
      `UPDATE anomaly_flags SET deleted_at=@t, updated_at=@t WHERE deleted_at IS NULL
       AND transaction_id IN (SELECT id FROM transactions WHERE account_id=@id AND deleted_at IS NULL)`
    ).run({ t, id })
    for (const table of ['transactions', 'account_balances']) {
      db.prepare(`UPDATE ${table} SET deleted_at=@t, updated_at=@t WHERE account_id=@id AND deleted_at IS NULL`).run({ t, id })
    }
    return true
  })()
}

// -------------------------------------------------------------- categories
export function createCategory(db: Db, input: NewCategoryInput): Category {
  const v = NewCategory.parse(input)
  if (v.parentId) assertLiveCategory(db, v.parentId)
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO categories (id,name,parent_id,kind,is_system,created_at,updated_at)
     VALUES (@id,@name,@parentId,@kind,0,@t,@t)`
  ).run({ ...v, id, t })
  return getCategory(db, id) as Category
}
export function getCategory(db: Db, id: string, includeDeleted = false): Category | undefined {
  const sql = `SELECT * FROM categories WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`
  return parseOne(Category, db.prepare(sql).get(id))
}
export function listCategories(db: Db): Category[] {
  return parseAll(
    Category,
    db.prepare('SELECT * FROM categories WHERE deleted_at IS NULL ORDER BY name').all()
  )
}
export function updateCategory(
  db: Db,
  id: string,
  patch: Partial<NewCategoryInput>
): Category | undefined {
  const cur = getCategory(db, id)
  if (!cur) return undefined
  if (cur.isSystem) throw new DbError('SYSTEM_CATEGORY_IMMUTABLE')
  const v = NewCategory.parse({ ...cur, ...patch })
  if (v.parentId) {
    assertLiveCategory(db, v.parentId)
    // Walk up from the proposed parent; reaching this category means a cycle.
    const seen = new Set<string>()
    for (let p: string | null = v.parentId; p; ) {
      if (p === id || seen.has(p)) throw new DbError('CATEGORY_CYCLE')
      seen.add(p)
      p = (db.prepare('SELECT parent_id FROM categories WHERE id=?').get(p) as { parent_id: string | null } | undefined)?.parent_id ?? null
    }
  }
  db.prepare(
    `UPDATE categories SET name=@name,parent_id=@parentId,kind=@kind,updated_at=@t WHERE id=@id`
  ).run({ ...v, id, t: now() })
  return getCategory(db, id)
}
/**
 * Soft-deletes a custom category atomically. In-use references move to Uncategorized so nothing
 * dangles: transactions and categorization rules are reassigned, budgets are reassigned (merged by
 * adding amounts when Uncategorized already has a budget for that month), child categories move up
 * to this category's parent, and recurring items lose their category.
 */
export function deleteCategory(db: Db, id: string): boolean {
  const cur = getCategory(db, id)
  if (cur?.isSystem) throw new DbError('SYSTEM_CATEGORY_IMMUTABLE')
  if (!cur) return false
  return db.transaction(() => {
    const t = now()
    const u = UNCATEGORIZED_CATEGORY_ID
    db.prepare('UPDATE transactions SET category_id=?, updated_at=? WHERE category_id=? AND deleted_at IS NULL').run(u, t, id)
    db.prepare('UPDATE categorization_rules SET category_id=?, updated_at=? WHERE category_id=? AND deleted_at IS NULL').run(u, t, id)
    db.prepare('UPDATE recurring_items SET category_id=NULL, updated_at=? WHERE category_id=? AND deleted_at IS NULL').run(t, id)
    db.prepare('UPDATE categories SET parent_id=?, updated_at=? WHERE parent_id=? AND deleted_at IS NULL').run(cur.parentId, t, id)
    const budgets = db
      .prepare('SELECT id, month, amount_cents FROM budgets WHERE category_id=? AND deleted_at IS NULL')
      .all(id) as { id: string; month: string; amount_cents: number }[]
    for (const b of budgets) {
      const target = db
        .prepare('SELECT id FROM budgets WHERE category_id=? AND month=? AND deleted_at IS NULL')
        .get(u, b.month) as { id: string } | undefined
      if (target) {
        db.prepare('UPDATE budgets SET amount_cents=amount_cents+?, updated_at=? WHERE id=?').run(b.amount_cents, t, target.id)
        db.prepare('UPDATE budgets SET deleted_at=?, updated_at=? WHERE id=?').run(t, t, b.id)
      } else {
        db.prepare('UPDATE budgets SET category_id=?, updated_at=? WHERE id=?').run(u, t, b.id)
      }
    }
    return softDelete(db, 'categories', id)
  })()
}

// ------------------------------------------------------------ transactions
export function createTransaction(db: Db, input: NewTransactionInput): Transaction {
  const v = NewTransaction.parse(input)
  assertLiveAccount(db, v.accountId)
  if (v.categoryId) assertLiveCategory(db, v.categoryId)
  // Effective flag: derived from the category kind (or a transfer link); an explicit true is honoured.
  v.isTransfer = v.isTransfer || v.transferLinkId !== null || categoryKind(db, v.categoryId) === 'transfer'
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO transactions (id,account_id,date,amount_cents,description_raw,description_normalized,
       merchant,category_id,import_id,fingerprint,source,confidence,is_transfer,transfer_link_id,created_at,updated_at)
     VALUES (@id,@accountId,@date,@amountCents,@descriptionRaw,@descriptionNormalized,
       @merchant,@categoryId,@importId,@fingerprint,@source,@confidence,@isTransfer,@transferLinkId,@t,@t)`
  ).run(toParams({ ...v, id, t }))
  return getTransaction(db, id) as Transaction
}
/** Atomic bulk insert (used by import commit). */
export function createTransactions(db: Db, inputs: NewTransactionInput[]): number {
  return db.transaction(() => {
    for (const i of inputs) createTransaction(db, i)
    return inputs.length
  })()
}
export function getTransaction(db: Db, id: string, includeDeleted = false): Transaction | undefined {
  const sql = `SELECT * FROM transactions WHERE id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`
  return parseOne(Transaction, db.prepare(sql).get(id))
}
export interface TransactionQuery extends Partial<Pick<AggregateFilter, 'from' | 'to' | 'accountId'>> {
  categoryId?: string
  limit?: number
  offset?: number
}
export function listTransactions(db: Db, q: TransactionQuery = {}): Transaction[] {
  if (q.limit !== undefined) PageLimit.parse(q.limit)
  if (q.offset !== undefined) z.number().int().min(0).parse(q.offset)
  if (q.from !== undefined) NewTransaction.shape.date.parse(q.from)
  if (q.to !== undefined) NewTransaction.shape.date.parse(q.to)
  const where = ['deleted_at IS NULL']
  const p: Record<string, unknown> = {}
  const filters: [keyof TransactionQuery, string][] = [
    ['from', 'date >= @from'],
    ['to', 'date <= @to'],
    ['accountId', 'account_id = @accountId'],
    ['categoryId', 'category_id = @categoryId']
  ]
  for (const [key, clause] of filters) {
    if (q[key] !== undefined) {
      where.push(clause)
      p[key] = q[key]
    }
  }
  p.limit = q.limit ?? -1
  p.offset = q.offset ?? 0
  return parseAll(
    Transaction,
    db
      .prepare(
        `SELECT * FROM transactions WHERE ${where.join(' AND ')}
         ORDER BY date DESC, created_at DESC, id LIMIT @limit OFFSET @offset`
      )
      .all(p)
  )
}
export function findByFingerprint(db: Db, fingerprint: string): Transaction[] {
  return parseAll(
    Transaction,
    db.prepare('SELECT * FROM transactions WHERE fingerprint=? AND deleted_at IS NULL').all(fingerprint)
  )
}
/**
 * Update a transaction. is_transfer is re-derived whenever the category is part of the patch (moving
 * a row off the Transfer category clears the flag); transfer legs (transfer_link_id set) and rows in
 * a transfer-kind category always stay flagged. An explicit patch.isTransfer is honoured otherwise.
 */
export function updateTransaction(
  db: Db,
  id: string,
  patch: TransactionPatchInput
): Transaction | undefined {
  const cur = getTransaction(db, id)
  if (!cur) return undefined
  const p = TransactionPatch.parse(patch)
  if (p.categoryId) assertLiveCategory(db, p.categoryId)
  const effCategory = p.categoryId !== undefined ? p.categoryId : cur.categoryId
  const base = p.isTransfer ?? (p.categoryId === undefined ? cur.isTransfer : false)
  const isTransfer = base || cur.transferLinkId !== null || categoryKind(db, effCategory) === 'transfer'
  const { accountId, ...rest } = NewTransaction.parse({ ...cur, ...stripUndefined(p), isTransfer })
  void accountId
  const cols = Object.keys(rest).map((k) => `${snake(k)}=@${k}`)
  db.prepare(`UPDATE transactions SET ${cols.join(',')}, updated_at=@t WHERE id=@id`).run(
    toParams({ ...rest, id, t: now() })
  )
  return getTransaction(db, id)
}
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
export const deleteTransaction = (db: Db, id: string): boolean => softDelete(db, 'transactions', id)

// ----------------------------------------------------------------- budgets
export function setBudget(db: Db, input: z.input<typeof NewBudget>): Budget {
  const v = NewBudget.parse(input)
  assertLiveCategory(db, v.categoryId)
  const t = now()
  const existing = db
    .prepare('SELECT id FROM budgets WHERE category_id=? AND month=? AND deleted_at IS NULL')
    .get(v.categoryId, v.month) as { id: string } | undefined
  const id = existing?.id ?? randomUUID()
  if (existing) {
    db.prepare('UPDATE budgets SET amount_cents=?, updated_at=? WHERE id=?').run(v.amountCents, t, id)
  } else {
    db.prepare(
      `INSERT INTO budgets (id,category_id,month,amount_cents,created_at,updated_at)
       VALUES (@id,@categoryId,@month,@amountCents,@t,@t)`
    ).run({ ...v, id, t })
  }
  return getBudget(db, id) as Budget
}
export function getBudget(db: Db, id: string): Budget | undefined {
  return parseOne(Budget, db.prepare('SELECT * FROM budgets WHERE id=? AND deleted_at IS NULL').get(id))
}
export function listBudgets(db: Db, month?: string): Budget[] {
  const rows = month
    ? db.prepare('SELECT * FROM budgets WHERE deleted_at IS NULL AND month=? ORDER BY category_id').all(month)
    : db.prepare('SELECT * FROM budgets WHERE deleted_at IS NULL ORDER BY month, category_id').all()
  return parseAll(Budget, rows)
}
export const deleteBudget = (db: Db, id: string): boolean => softDelete(db, 'budgets', id)

// ----------------------------------------------------------------- imports
export function createImport(db: Db, input: NewImportInput): ImportRecord {
  const v = NewImport.parse(input)
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO imports (id,file_name,file_type,file_hash,imported_at,row_count,retained_file_path,created_at,updated_at)
     VALUES (@id,@fileName,@fileType,@fileHash,@importedAt,@rowCount,@retainedFilePath,@t,@t)`
  ).run({ ...v, importedAt: v.importedAt ?? t, id, t })
  return getImport(db, id) as ImportRecord
}
export function getImport(db: Db, id: string): ImportRecord | undefined {
  return parseOne(ImportRecord, db.prepare('SELECT * FROM imports WHERE id=? AND deleted_at IS NULL').get(id))
}
export function findImportByHash(db: Db, fileHash: string): ImportRecord | undefined {
  return parseOne(
    ImportRecord,
    db.prepare('SELECT * FROM imports WHERE file_hash=? AND deleted_at IS NULL').get(fileHash)
  )
}
export function listImports(db: Db): ImportRecord[] {
  return parseAll(
    ImportRecord,
    db.prepare('SELECT * FROM imports WHERE deleted_at IS NULL ORDER BY imported_at DESC').all()
  )
}
export function updateImportRowCount(db: Db, id: string, rowCount: number): void {
  db.prepare('UPDATE imports SET row_count=?, updated_at=? WHERE id=? AND deleted_at IS NULL').run(rowCount, now(), id)
}
export const deleteImport = (db: Db, id: string): boolean => softDelete(db, 'imports', id)

// ---------------------------------------------------------------- settings
export function getSetting(db: Db, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined
  return r?.value
}
export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(key, value, now())
}
export function listSettings(db: Db): Setting[] {
  return parseAll(Setting, db.prepare('SELECT * FROM settings ORDER BY key').all())
}
/** Settings are key/value with no tombstone column: delete is a hard delete. */
export function deleteSetting(db: Db, key: string): boolean {
  return db.prepare('DELETE FROM settings WHERE key=?').run(key).changes > 0
}

// -------------------------------------------------------------- aggregates
/**
 * Dashboard aggregates classify rows by CATEGORY KIND, never by the sign of the amount:
 *   - income   = SUM(amount) over income-kind categories. Negative rows there (reversals,
 *                chargebacks of income) net against income, never against spending.
 *   - spending = -SUM(amount) over expense-kind categories AND uncategorized rows. Positive rows
 *                (refunds) net against their own category; positive uncategorized rows net against
 *                the Uncategorized bucket. Spending can therefore be negative for a category or a
 *                month in which refunds exceed purchases; it is never clamped, so every view sums
 *                to the same total.
 *   - transfers (is_transfer flag, or transfer-kind category) and soft-deleted rows/accounts are
 *                excluded everywhere.
 * Uncategorized = NULL category_id; reported as the Uncategorized system category. The optimizer
 * (analysis/optimizer/spending.ts) applies the identical rules.
 */
const AGG_FROM = `
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id AND a.deleted_at IS NULL
  LEFT JOIN categories c ON c.id = t.category_id
  WHERE t.deleted_at IS NULL
    AND t.is_transfer = 0
    AND (c.kind IS NULL OR c.kind <> 'transfer')
    AND t.date >= @from AND t.date <= @to
    AND (@accountId IS NULL OR t.account_id = @accountId)`

const IS_INCOME = `c.kind = 'income'`
const IS_SPENDING = `COALESCE(c.kind, 'expense') = 'expense'`

function aggParams(f: AggregateFilter): { from: string; to: string; accountId: string | null } {
  const v = AggregateFilter.parse(f)
  return { from: v.from, to: v.to, accountId: v.accountId ?? null }
}

/** Net income and net spending per month. */
export function incomeVsExpensesByMonth(db: Db, f: AggregateFilter): MonthlyTotals[] {
  return parseAll(
    MonthlyTotals,
    db
      .prepare(
        `SELECT substr(t.date,1,7) AS month,
                COALESCE(SUM(CASE WHEN ${IS_INCOME} THEN t.amount_cents END),0) AS income_cents,
                COALESCE(-SUM(CASE WHEN ${IS_SPENDING} THEN t.amount_cents END),0) AS expense_cents
         ${AGG_FROM} GROUP BY month ORDER BY month`
      )
      .all(aggParams(f))
  )
}

/** Net spending per month. */
export function spendingByMonth(db: Db, f: AggregateFilter): { month: string; expenseCents: number }[] {
  return incomeVsExpensesByMonth(db, f).map(({ month, expenseCents }) => ({ month, expenseCents }))
}

/** Net spending per category, largest first. Uncategorized rows are reported under the Uncategorized category. */
export function spendingByCategory(db: Db, f: AggregateFilter): CategorySpend[] {
  return parseAll(
    CategorySpend,
    db
      .prepare(
        `SELECT COALESCE(t.category_id, @uncat) AS category_id, COALESCE(c.name,'Uncategorized') AS category_name,
                -SUM(t.amount_cents) AS expense_cents
         ${AGG_FROM} AND ${IS_SPENDING}
         GROUP BY COALESCE(t.category_id, @uncat) HAVING expense_cents <> 0
         ORDER BY expense_cents DESC, category_name`
      )
      .all({ ...aggParams(f), uncat: UNCATEGORIZED_CATEGORY_ID })
  )
}

/** Top merchants by net spending (falls back to normalized/raw description). */
export function topMerchants(db: Db, f: AggregateFilter, limit = 10): MerchantSpend[] {
  const lim = z.number().int().min(1).max(MAX_PAGE_SIZE).parse(limit)
  return parseAll(
    MerchantSpend,
    db
      .prepare(
        `SELECT COALESCE(NULLIF(t.merchant,''), NULLIF(t.description_normalized,''), t.description_raw) AS merchant,
                -SUM(t.amount_cents) AS expense_cents, COUNT(*) AS count
         ${AGG_FROM} AND ${IS_SPENDING}
         GROUP BY merchant HAVING expense_cents <> 0
         ORDER BY expense_cents DESC, merchant LIMIT @limit`
      )
      .all({ ...aggParams(f), limit: lim })
  )
}
