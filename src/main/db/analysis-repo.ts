import { randomUUID } from 'node:crypto'
import {
  merchantKey,
  type AnomalyFlag,
  type AnomalyReasonCode,
  type FlagSuppression,
  type OptBudget,
  type OptCategory,
  type OptimizerInput,
  type OptTransaction,
  type Subscription
} from '../analysis/optimizer/types'
import { normalizeDescription } from '../ingest/normalize'
import type { Db } from './connection'

/**
 * DB glue for the budget optimizer. The optimizer itself is pure; this file loads its inputs with
 * SQL and persists its outputs (subscriptions -> recurring_items, flags -> anomaly_flags).
 * Flag reason text lives in anomaly_flags.reason (migration 2). Suppressions have no dedicated
 * table and stay in the `settings` table:
 *   - `optimizer.flag_suppressions`  JSON array of {reasonCode, merchant}
 */

const now = (): string => new Date().toISOString()
const SUPPRESSIONS_KEY = 'optimizer.flag_suppressions'

export type SubscriptionStatus = 'active' | 'confirmed' | 'rejected'
export type FlagStatus = 'open' | 'dismissed' | 'confirmed'

// ------------------------------------------------------------------ input loading
export function loadOptimizerInput(db: Db, today: string): OptimizerInput {
  const txRows = db
    .prepare(
      `SELECT t.id, t.date, t.amount_cents AS amountCents, t.description_normalized AS norm,
              t.merchant, t.description_raw AS raw, t.category_id AS categoryId, t.is_transfer AS isTransfer
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id AND a.deleted_at IS NULL
       WHERE t.deleted_at IS NULL AND t.date <= ?
       ORDER BY t.date, t.id`
    )
    .all(today) as {
    id: string
    date: string
    amountCents: number
    norm: string | null
    merchant: string | null
    raw: string
    categoryId: string | null
    isTransfer: number
  }[]
  const transactions: OptTransaction[] = txRows.map((r) => ({
    id: r.id,
    date: r.date,
    amountCents: r.amountCents,
    merchant: merchantKey(r.norm ?? normalizeDescription(r.merchant ?? r.raw)),
    categoryId: r.categoryId,
    isTransfer: r.isTransfer === 1
  }))
  const categories = db
    .prepare('SELECT id, name, kind FROM categories WHERE deleted_at IS NULL')
    .all() as OptCategory[]
  const budgets = db
    .prepare('SELECT category_id AS categoryId, month, amount_cents AS amountCents FROM budgets WHERE deleted_at IS NULL')
    .all() as OptBudget[]
  const subNames = (status: SubscriptionStatus): string[] =>
    (
      db
        .prepare('SELECT name FROM recurring_items WHERE is_subscription=1 AND status=? AND deleted_at IS NULL')
        .all(status) as { name: string }[]
    ).map((r) => merchantKey(r.name))
  return {
    today,
    transactions,
    categories,
    budgets,
    rejectedSubscriptions: subNames('rejected'),
    confirmedSubscriptions: subNames('confirmed'),
    suppressions: listSuppressions(db)
  }
}

// ------------------------------------------------------------------ subscriptions
export interface SubscriptionRecord {
  id: string
  name: string
  amountCents: number
  cadence: string
  nextDue: string | null
  categoryId: string | null
  status: string
}

/**
 * Insert detected subscriptions into recurring_items, or refresh amount/cadence/next_due of existing
 * rows (matched by merchant name). The user's status (confirmed/rejected) is never overwritten.
 * Returns the record id for each input subscription, in input order.
 */
export function persistSubscriptions(db: Db, subs: readonly Subscription[]): string[] {
  const t = now()
  const find = db.prepare(
    'SELECT id FROM recurring_items WHERE is_subscription=1 AND name=? AND deleted_at IS NULL'
  )
  const upd = db.prepare(
    'UPDATE recurring_items SET amount_cents=?, cadence=?, next_due=?, category_id=?, updated_at=? WHERE id=?'
  )
  const ins = db.prepare(
    `INSERT INTO recurring_items (id,name,amount_cents,cadence,next_due,category_id,is_subscription,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,1,'active',?,?)`
  )
  const ids: string[] = []
  db.transaction(() => {
    for (const s of subs) {
      const ex = find.get(s.merchant) as { id: string } | undefined
      if (ex) {
        upd.run(s.amountCents, s.cadence, s.nextExpected, s.categoryId, t, ex.id)
        ids.push(ex.id)
      } else {
        const id = randomUUID()
        ins.run(id, s.merchant, s.amountCents, s.cadence, s.nextExpected, s.categoryId, t, t)
        ids.push(id)
      }
    }
  })()
  return ids
}

export function listSubscriptionRecords(db: Db): SubscriptionRecord[] {
  return db
    .prepare(
      `SELECT id, name, amount_cents AS amountCents, cadence, next_due AS nextDue, category_id AS categoryId, status
       FROM recurring_items WHERE is_subscription=1 AND deleted_at IS NULL ORDER BY name`
    )
    .all() as SubscriptionRecord[]
}

/** Confirm or reject (rejections are remembered: the row stays and detection skips that merchant). */
export function setSubscriptionStatus(db: Db, id: string, status: SubscriptionStatus): boolean {
  return (
    db
      .prepare('UPDATE recurring_items SET status=?, updated_at=? WHERE id=? AND is_subscription=1 AND deleted_at IS NULL')
      .run(status, now(), id).changes > 0
  )
}

// ------------------------------------------------------------------ suppressions
export function listSuppressions(db: Db): FlagSuppression[] {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(SUPPRESSIONS_KEY) as { value: string } | undefined
  if (!r) return []
  try {
    const parsed: unknown = JSON.parse(r.value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is FlagSuppression =>
        typeof x === 'object' && x !== null && typeof (x as FlagSuppression).reasonCode === 'string' &&
        typeof (x as FlagSuppression).merchant === 'string'
    )
  } catch {
    return []
  }
}

export function addSuppression(db: Db, reasonCode: AnomalyReasonCode, merchant: string): void {
  const list = listSuppressions(db)
  if (list.some((s) => s.reasonCode === reasonCode && s.merchant === merchant)) return
  list.push({ reasonCode, merchant })
  putSetting(db, SUPPRESSIONS_KEY, JSON.stringify(list))
}

function putSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(key, value, now())
}

// ------------------------------------------------------------------ anomaly flags
export interface FlagRecord {
  id: string
  transactionId: string
  reasonCode: string
  severity: string
  status: FlagStatus
  /** Empty string if the reason text was not stored. */
  reason: string
  createdAt: string
}

/**
 * Persist newly detected flags. A flag already stored for the same (transaction, reason) is skipped
 * whatever its status, so dismissed or confirmed flags do not reappear. Returns the record id for each
 * input flag (new or already stored), in input order.
 */
export function persistFlags(db: Db, flags: readonly AnomalyFlag[]): string[] {
  const t = now()
  const exists = db.prepare(
    'SELECT id FROM anomaly_flags WHERE transaction_id=? AND reason_code=? AND deleted_at IS NULL'
  )
  const ins = db.prepare(
    `INSERT INTO anomaly_flags (id,transaction_id,reason_code,severity,status,reason,created_at,updated_at)
     VALUES (?,?,?,?, 'open', ?, ?, ?)`
  )
  const ids: string[] = []
  db.transaction(() => {
    for (const f of flags) {
      const ex = exists.get(f.transactionId, f.reasonCode) as { id: string } | undefined
      if (ex) {
        ids.push(ex.id)
        continue
      }
      const id = randomUUID()
      ins.run(id, f.transactionId, f.reasonCode, f.severity, f.reason, t, t)
      ids.push(id)
    }
  })()
  return ids
}

export function listFlags(db: Db, status?: FlagStatus): FlagRecord[] {
  const sql = `SELECT f.id, f.transaction_id AS transactionId, f.reason_code AS reasonCode, f.severity,
                      f.status, COALESCE(f.reason,'') AS reason, f.created_at AS createdAt
               FROM anomaly_flags f
               WHERE f.deleted_at IS NULL ${status ? 'AND f.status=?' : ''}
               ORDER BY f.created_at DESC, f.id`
  const stmt = db.prepare(sql)
  return (status ? stmt.all(status) : stmt.all()) as FlagRecord[]
}

export function setFlagStatus(db: Db, id: string, status: FlagStatus): boolean {
  return (
    db.prepare('UPDATE anomaly_flags SET status=?, updated_at=? WHERE id=? AND deleted_at IS NULL').run(status, now(), id)
      .changes > 0
  )
}

/** Mark legitimate: dismisses the flag and suppresses similar future flags (same reason + merchant). */
export function markFlagLegitimate(db: Db, id: string): boolean {
  const row = db
    .prepare(
      `SELECT f.reason_code AS reasonCode, t.description_normalized AS norm, t.merchant, t.description_raw AS raw
       FROM anomaly_flags f JOIN transactions t ON t.id = f.transaction_id
       WHERE f.id=? AND f.deleted_at IS NULL`
    )
    .get(id) as { reasonCode: AnomalyReasonCode; norm: string | null; merchant: string | null; raw: string } | undefined
  if (!row) return false
  db.transaction(() => {
    setFlagStatus(db, id, 'dismissed')
    addSuppression(db, row.reasonCode, merchantKey(row.norm ?? normalizeDescription(row.merchant ?? row.raw)))
  })()
  return true
}

export function markFlagSuspicious(db: Db, id: string): boolean {
  return setFlagStatus(db, id, 'confirmed')
}

export function deleteFlag(db: Db, id: string): boolean {
  const t = now()
  return (
    db.prepare('UPDATE anomaly_flags SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL').run(t, t, id)
      .changes > 0
  )
}
