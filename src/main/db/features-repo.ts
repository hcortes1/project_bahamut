/**
 * SQL for section 9 features (balances, recurring items, goals, transfers,
 * export). Pure data access: no business rules, no zod; callers in
 * src/main/features validate. All reads exclude soft-deleted rows.
 */
import { randomUUID } from 'node:crypto'
import type { Db } from './connection'

const now = (): string => new Date().toISOString()

// ---------------------------------------------------------------- balances
export interface BalanceRow {
  id: string
  accountId: string
  date: string
  balanceCents: number
}
interface BalanceRaw {
  id: string
  account_id: string
  date: string
  balance_cents: number
}
const toBalance = (r: BalanceRaw): BalanceRow => ({
  id: r.id,
  accountId: r.account_id,
  date: r.date,
  balanceCents: r.balance_cents
})

export function findBalanceOnDate(db: Db, accountId: string, date: string): BalanceRow | undefined {
  const r = db
    .prepare(
      'SELECT * FROM account_balances WHERE account_id=? AND date=? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1'
    )
    .get(accountId, date) as BalanceRaw | undefined
  return r && toBalance(r)
}
export function getBalance(db: Db, id: string): BalanceRow | undefined {
  const r = db.prepare('SELECT * FROM account_balances WHERE id=? AND deleted_at IS NULL').get(id) as
    | BalanceRaw
    | undefined
  return r && toBalance(r)
}
export function insertBalance(db: Db, accountId: string, date: string, balanceCents: number): string {
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO account_balances (id,account_id,date,balance_cents,created_at,updated_at)
     VALUES (?,?,?,?,?,?)`
  ).run(id, accountId, date, balanceCents, t, t)
  return id
}
export function updateBalanceCents(db: Db, id: string, balanceCents: number): void {
  db.prepare('UPDATE account_balances SET balance_cents=?, updated_at=? WHERE id=?').run(
    balanceCents,
    now(),
    id
  )
}
export function listBalanceRows(db: Db, accountId: string, from?: string, to?: string): BalanceRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM account_balances
       WHERE account_id=@accountId AND deleted_at IS NULL
         AND (@from IS NULL OR date >= @from) AND (@to IS NULL OR date <= @to)
       ORDER BY date, created_at`
    )
    .all({ accountId, from: from ?? null, to: to ?? null }) as BalanceRaw[]
  return rows.map(toBalance)
}
export function softDeleteRow(db: Db, table: string, id: string): boolean {
  if (!/^[a-z_]+$/.test(table)) throw new Error('bad table')
  const t = now()
  return (
    db
      .prepare(`UPDATE ${table} SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL`)
      .run(t, t, id).changes > 0
  )
}

export interface LatestBalance {
  accountId: string
  accountType: 'checking' | 'savings' | 'credit_card'
  /** null when no snapshot exists on or before asOf */
  balanceCents: number | null
}
/** Latest snapshot per live account with date <= asOf. */
export function latestBalancesAsOf(db: Db, asOf: string): LatestBalance[] {
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.type AS account_type,
         (SELECT b.balance_cents FROM account_balances b
           WHERE b.account_id = a.id AND b.deleted_at IS NULL AND b.date <= @asOf
           ORDER BY b.date DESC, b.created_at DESC, b.rowid DESC LIMIT 1) AS balance_cents
       FROM accounts a WHERE a.deleted_at IS NULL ORDER BY a.name, a.id`
    )
    .all({ asOf }) as { account_id: string; account_type: LatestBalance['accountType']; balance_cents: number | null }[]
  return rows.map((r) => ({
    accountId: r.account_id,
    accountType: r.account_type,
    balanceCents: r.balance_cents
  }))
}

// --------------------------------------------------------------- recurring
export interface RecurringRow {
  id: string
  name: string
  amountCents: number
  cadence: string
  nextDue: string | null
  categoryId: string | null
  isSubscription: boolean
  status: string
}
interface RecurringRaw {
  id: string
  name: string
  amount_cents: number
  cadence: string
  next_due: string | null
  category_id: string | null
  is_subscription: number
  status: string
}
const toRecurring = (r: RecurringRaw): RecurringRow => ({
  id: r.id,
  name: r.name,
  amountCents: r.amount_cents,
  cadence: r.cadence,
  nextDue: r.next_due,
  categoryId: r.category_id,
  isSubscription: r.is_subscription === 1,
  status: r.status
})
export type RecurringWrite = Omit<RecurringRow, 'id'>

export function insertRecurring(db: Db, v: RecurringWrite): string {
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO recurring_items (id,name,amount_cents,cadence,next_due,category_id,is_subscription,status,created_at,updated_at)
     VALUES (@id,@name,@amountCents,@cadence,@nextDue,@categoryId,@sub,@status,@t,@t)`
  ).run({ ...v, id, sub: v.isSubscription ? 1 : 0, t })
  return id
}
export function updateRecurringRow(db: Db, id: string, v: RecurringWrite): void {
  db.prepare(
    `UPDATE recurring_items SET name=@name,amount_cents=@amountCents,cadence=@cadence,next_due=@nextDue,
       category_id=@categoryId,is_subscription=@sub,status=@status,updated_at=@t WHERE id=@id`
  ).run({ ...v, id, sub: v.isSubscription ? 1 : 0, t: now() })
}
export function getRecurringRow(db: Db, id: string): RecurringRow | undefined {
  const r = db.prepare('SELECT * FROM recurring_items WHERE id=? AND deleted_at IS NULL').get(id) as
    | RecurringRaw
    | undefined
  return r && toRecurring(r)
}
export function listRecurringRows(db: Db, status?: string): RecurringRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM recurring_items WHERE deleted_at IS NULL AND (@status IS NULL OR status=@status)
       ORDER BY (next_due IS NULL), next_due, name, id`
    )
    .all({ status: status ?? null }) as RecurringRaw[]
  return rows.map(toRecurring)
}

// ------------------------------------------------------------------- goals
export interface GoalRow {
  id: string
  name: string
  targetCents: number
  targetDate: string | null
  currentCents: number
}
interface GoalRaw {
  id: string
  name: string
  target_cents: number
  target_date: string | null
  current_cents: number
}
const toGoal = (r: GoalRaw): GoalRow => ({
  id: r.id,
  name: r.name,
  targetCents: r.target_cents,
  targetDate: r.target_date,
  currentCents: r.current_cents
})
export function insertGoalRow(
  db: Db,
  v: { name: string; targetCents: number; targetDate: string | null }
): string {
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO savings_goals (id,name,target_cents,target_date,current_cents,created_at,updated_at)
     VALUES (@id,@name,@targetCents,@targetDate,0,@t,@t)`
  ).run({ ...v, id, t })
  return id
}
export function updateGoalRow(
  db: Db,
  id: string,
  v: { name: string; targetCents: number; targetDate: string | null }
): void {
  db.prepare(
    'UPDATE savings_goals SET name=@name,target_cents=@targetCents,target_date=@targetDate,updated_at=@t WHERE id=@id'
  ).run({ ...v, id, t: now() })
}
export function getGoalRow(db: Db, id: string): GoalRow | undefined {
  const r = db.prepare('SELECT * FROM savings_goals WHERE id=? AND deleted_at IS NULL').get(id) as
    | GoalRaw
    | undefined
  return r && toGoal(r)
}
export function listGoalRows(db: Db): GoalRow[] {
  const rows = db
    .prepare('SELECT * FROM savings_goals WHERE deleted_at IS NULL ORDER BY name, id')
    .all() as GoalRaw[]
  return rows.map(toGoal)
}
/** Recompute current_cents as the sum of live contributions. Returns the new value. */
export function recomputeGoalCurrent(db: Db, goalId: string): number {
  const r = db
    .prepare(
      'SELECT COALESCE(SUM(amount_cents),0) AS s FROM goal_contributions WHERE goal_id=? AND deleted_at IS NULL'
    )
    .get(goalId) as { s: number }
  db.prepare('UPDATE savings_goals SET current_cents=?, updated_at=? WHERE id=?').run(r.s, now(), goalId)
  return r.s
}
export function softDeleteGoalContributions(db: Db, goalId: string): void {
  const t = now()
  db.prepare(
    'UPDATE goal_contributions SET deleted_at=?, updated_at=? WHERE goal_id=? AND deleted_at IS NULL'
  ).run(t, t, goalId)
}

export interface ContributionRow {
  id: string
  goalId: string
  date: string
  amountCents: number
}
interface ContributionRaw {
  id: string
  goal_id: string
  date: string
  amount_cents: number
}
const toContribution = (r: ContributionRaw): ContributionRow => ({
  id: r.id,
  goalId: r.goal_id,
  date: r.date,
  amountCents: r.amount_cents
})
export function insertContributionRow(db: Db, goalId: string, date: string, amountCents: number): string {
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO goal_contributions (id,goal_id,date,amount_cents,created_at,updated_at)
     VALUES (?,?,?,?,?,?)`
  ).run(id, goalId, date, amountCents, t, t)
  return id
}
export function updateContributionRow(db: Db, id: string, date: string, amountCents: number): void {
  db.prepare('UPDATE goal_contributions SET date=?, amount_cents=?, updated_at=? WHERE id=?').run(
    date,
    amountCents,
    now(),
    id
  )
}
export function getContributionRow(db: Db, id: string): ContributionRow | undefined {
  const r = db.prepare('SELECT * FROM goal_contributions WHERE id=? AND deleted_at IS NULL').get(id) as
    | ContributionRaw
    | undefined
  return r && toContribution(r)
}
export function listContributionRows(db: Db, goalId: string): ContributionRow[] {
  const rows = db
    .prepare(
      'SELECT * FROM goal_contributions WHERE goal_id=? AND deleted_at IS NULL ORDER BY date, created_at, id'
    )
    .all(goalId) as ContributionRaw[]
  return rows.map(toContribution)
}
/** Sum of all live goal contributions dated <= asOf, on live goals. */
export function goalsTotalAsOf(db: Db, asOf: string): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(c.amount_cents),0) AS s
       FROM goal_contributions c JOIN savings_goals g ON g.id=c.goal_id AND g.deleted_at IS NULL
       WHERE c.deleted_at IS NULL AND c.date <= ?`
    )
    .get(asOf) as { s: number }
  return r.s
}
/** Sum of current_cents over live goals. */
export function goalsCurrentTotal(db: Db): number {
  const r = db
    .prepare('SELECT COALESCE(SUM(current_cents),0) AS s FROM savings_goals WHERE deleted_at IS NULL')
    .get() as { s: number }
  return r.s
}

// --------------------------------------------------------------- transfers
export interface LegRow {
  id: string
  accountId: string
  date: string
  amountCents: number
  descriptionRaw: string
}
interface LegRaw {
  id: string
  account_id: string
  date: string
  amount_cents: number
  description_raw: string
}
const toLeg = (r: LegRaw): LegRow => ({
  id: r.id,
  accountId: r.account_id,
  date: r.date,
  amountCents: r.amount_cents,
  descriptionRaw: r.description_raw
})
/** Legs of a transfer share transactions.transfer_link_id (migration 2). */
export function listLegs(db: Db, linkId: string): LegRow[] {
  const rows = db
    .prepare(
      `SELECT id,account_id,date,amount_cents,description_raw FROM transactions
       WHERE transfer_link_id=? AND deleted_at IS NULL ORDER BY amount_cents, id`
    )
    .all(linkId) as LegRaw[]
  return rows.map(toLeg)
}
export function updateLeg(
  db: Db,
  id: string,
  v: { accountId: string; date: string; amountCents: number; descriptionRaw: string }
): void {
  db.prepare(
    `UPDATE transactions SET account_id=@accountId,date=@date,amount_cents=@amountCents,
       description_raw=@descriptionRaw,description_normalized=NULL,updated_at=@t WHERE id=@id`
  ).run({ ...v, id, t: now() })
}
export function softDeleteLegs(db: Db, linkId: string): number {
  const t = now()
  return db
    .prepare(
      'UPDATE transactions SET deleted_at=?, updated_at=? WHERE transfer_link_id=? AND deleted_at IS NULL'
    )
    .run(t, t, linkId).changes
}

// ------------------------------------------------------------------ export
export interface ExportTxRow {
  date: string
  accountName: string
  description: string
  merchant: string | null
  categoryName: string | null
  amountCents: number
  isTransfer: boolean
  source: string
}
export function listExportTransactions(
  db: Db,
  from: string,
  to: string,
  accountId?: string
): ExportTxRow[] {
  const rows = db
    .prepare(
      `SELECT t.date, a.name AS account_name, t.description_raw, t.merchant, c.name AS category_name,
              t.amount_cents, t.is_transfer, t.source
       FROM transactions t
       JOIN accounts a ON a.id=t.account_id AND a.deleted_at IS NULL
       LEFT JOIN categories c ON c.id=t.category_id
       WHERE t.deleted_at IS NULL AND t.date >= @from AND t.date <= @to
         AND (@accountId IS NULL OR t.account_id=@accountId)
       ORDER BY t.date, t.created_at, t.id`
    )
    .all({ from, to, accountId: accountId ?? null }) as {
    date: string
    account_name: string
    description_raw: string
    merchant: string | null
    category_name: string | null
    amount_cents: number
    is_transfer: number
    source: string
  }[]
  return rows.map((r) => ({
    date: r.date,
    accountName: r.account_name,
    description: r.description_raw,
    merchant: r.merchant,
    categoryName: r.category_name,
    amountCents: r.amount_cents,
    isTransfer: r.is_transfer === 1,
    source: r.source
  }))
}
