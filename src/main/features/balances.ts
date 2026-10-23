/** Dated per-account balance snapshots (account_balances). */
import { z } from 'zod'
import type { Db } from '../db/connection'
import { getAccount } from '../db/repos'
import {
  findBalanceOnDate,
  getBalance,
  insertBalance,
  listBalanceRows,
  softDeleteRow,
  updateBalanceCents,
  type BalanceRow
} from '../db/features-repo'
import { FeatureError, Id, SafeCents, ValidDate } from './common'

export type AccountBalance = BalanceRow

export const RecordBalance = z.object({ accountId: Id, date: ValidDate, balanceCents: SafeCents })
export type RecordBalanceInput = z.input<typeof RecordBalance>

/**
 * Record a snapshot. At most one live snapshot per account per date: recording
 * again for the same date replaces the amount. Credit cards: record the amount
 * OWED as a positive number (see networth.ts).
 */
export function recordBalance(db: Db, input: RecordBalanceInput): AccountBalance {
  const v = RecordBalance.parse(input)
  if (!getAccount(db, v.accountId)) throw new FeatureError('ACCOUNT_NOT_FOUND')
  return db.transaction(() => {
    const existing = findBalanceOnDate(db, v.accountId, v.date)
    if (existing) {
      updateBalanceCents(db, existing.id, v.balanceCents)
      return getBalance(db, existing.id) as AccountBalance
    }
    return getBalance(db, insertBalance(db, v.accountId, v.date, v.balanceCents)) as AccountBalance
  })()
}

export const ListBalances = z.object({
  accountId: Id,
  from: ValidDate.optional(),
  to: ValidDate.optional()
})
/** Snapshots for one account, oldest first. */
export function listBalances(db: Db, query: z.input<typeof ListBalances>): AccountBalance[] {
  const v = ListBalances.parse(query)
  return listBalanceRows(db, v.accountId, v.from, v.to)
}

export function latestBalance(db: Db, accountId: string, asOf?: string): AccountBalance | undefined {
  const rows = listBalanceRows(db, accountId, undefined, asOf ? ValidDate.parse(asOf) : undefined)
  return rows[rows.length - 1]
}

export const deleteBalance = (db: Db, id: string): boolean => softDeleteRow(db, 'account_balances', id)
