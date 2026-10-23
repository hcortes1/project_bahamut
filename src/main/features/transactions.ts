/**
 * Manual transactions and transfers between accounts.
 *
 * A transfer is two live transaction rows ("legs"): an outflow (negative) on
 * the source account and an inflow (positive) on the destination, both with
 * is_transfer=1 and the Transfer system category, so every aggregate ignores
 * them. Legs share transactions.transfer_link_id (migration 2); their
 * fingerprint stays NULL/real. Editing/deleting always touches both legs
 * inside one SQLite transaction.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Transaction } from '@shared/db-types'
import type { Db } from '../db/connection'
import {
  createTransaction,
  getAccount,
  getTransaction,
  deleteTransaction as softDeleteTransaction,
  updateTransaction
} from '../db/repos'
import { TRANSFER_CATEGORY_ID } from '../db/system-categories'
import { listLegs, softDeleteLegs, updateLeg } from '../db/features-repo'
import { FeatureError, Id, NonZeroCents, PositiveCents, ValidDate } from './common'

export const NewManualTransaction = z.object({
  accountId: Id,
  date: ValidDate,
  amountCents: NonZeroCents,
  description: z.string().trim().min(1).max(500),
  merchant: z.string().trim().max(200).nullable().default(null),
  categoryId: Id.nullable().default(null)
})
export type NewManualTransactionInput = z.input<typeof NewManualTransaction>

export const ManualTransactionPatch = z
  .object({
    date: ValidDate,
    amountCents: NonZeroCents,
    description: z.string().trim().min(1).max(500),
    merchant: z.string().trim().max(200).nullable(),
    categoryId: Id.nullable()
  })
  .partial()
export type ManualTransactionPatchInput = z.input<typeof ManualTransactionPatch>

export const NewTransfer = z
  .object({
    fromAccountId: Id,
    toAccountId: Id,
    date: ValidDate,
    amountCents: PositiveCents,
    description: z.string().trim().min(1).max(500).default('Transfer')
  })
  .refine((v) => v.fromAccountId !== v.toAccountId, {
    message: 'source and destination accounts must differ',
    path: ['toAccountId']
  })
export type NewTransferInput = z.input<typeof NewTransfer>

export const TransferPatch = z
  .object({
    fromAccountId: Id,
    toAccountId: Id,
    date: ValidDate,
    amountCents: PositiveCents,
    description: z.string().trim().min(1).max(500)
  })
  .partial()
export type TransferPatchInput = z.input<typeof TransferPatch>

export interface Transfer {
  linkId: string
  date: string
  /** Positive magnitude. */
  amountCents: number
  description: string
  fromAccountId: string
  toAccountId: string
  outLegId: string
  inLegId: string
}

const requireAccount = (db: Db, id: string): void => {
  if (!getAccount(db, id)) throw new FeatureError('ACCOUNT_NOT_FOUND')
}

const linkIdOf = (tx: Transaction): string | null => tx.transferLinkId

// ------------------------------------------------------------ manual txs
export function createManualTransaction(db: Db, input: NewManualTransactionInput): Transaction {
  const v = NewManualTransaction.parse(input)
  if (v.categoryId === TRANSFER_CATEGORY_ID) throw new FeatureError('USE_CREATE_TRANSFER')
  requireAccount(db, v.accountId)
  return createTransaction(db, {
    accountId: v.accountId,
    date: v.date,
    amountCents: v.amountCents,
    descriptionRaw: v.description,
    merchant: v.merchant,
    categoryId: v.categoryId,
    source: 'manual'
  })
}

/** Edit a transaction. Transfer legs are routed to the transfer so both legs stay in sync. */
export function updateManualTransaction(
  db: Db,
  id: string,
  patch: ManualTransactionPatchInput
): Transaction | undefined {
  const p = ManualTransactionPatch.parse(patch)
  return db.transaction(() => {
    const cur = getTransaction(db, id)
    if (!cur) return undefined
    const link = linkIdOf(cur)
    if (link) {
      if (p.categoryId !== undefined || p.merchant !== undefined) {
        throw new FeatureError('TRANSFER_LEG_IMMUTABLE_FIELD')
      }
      const tp: TransferPatchInput = {}
      if (p.date !== undefined) tp.date = p.date
      if (p.description !== undefined) tp.description = p.description
      if (p.amountCents !== undefined) {
        if (Math.sign(p.amountCents) !== Math.sign(cur.amountCents)) {
          throw new FeatureError('TRANSFER_SIGN_CHANGE')
        }
        tp.amountCents = Math.abs(p.amountCents)
      }
      updateTransfer(db, link, tp)
      return getTransaction(db, id)
    }
    if (p.categoryId === TRANSFER_CATEGORY_ID) throw new FeatureError('USE_CREATE_TRANSFER')
    const { description, ...rest } = p
    return updateTransaction(db, id, {
      ...rest,
      ...(description !== undefined ? { descriptionRaw: description } : {})
    })
  })()
}

/** Soft-delete a transaction; deleting either leg of a transfer deletes both. */
export function deleteManualTransaction(db: Db, id: string): boolean {
  return db.transaction(() => {
    const cur = getTransaction(db, id)
    if (!cur) return false
    const link = linkIdOf(cur)
    if (link) return softDeleteLegs(db, link) > 0
    return softDeleteTransaction(db, id)
  })()
}

// ------------------------------------------------------------- transfers
export function createTransfer(db: Db, input: NewTransferInput): Transfer {
  const v = NewTransfer.parse(input)
  requireAccount(db, v.fromAccountId)
  requireAccount(db, v.toAccountId)
  const linkId = randomUUID()
  db.transaction(() => {
    const common = {
      date: v.date,
      descriptionRaw: v.description,
      categoryId: TRANSFER_CATEGORY_ID,
      transferLinkId: linkId,
      source: 'manual' as const,
      isTransfer: true
    }
    createTransaction(db, { ...common, accountId: v.fromAccountId, amountCents: -v.amountCents })
    createTransaction(db, { ...common, accountId: v.toAccountId, amountCents: v.amountCents })
  })()
  return getTransfer(db, linkId) as Transfer
}

export function getTransfer(db: Db, linkId: string): Transfer | undefined {
  const legs = listLegs(db, linkId)
  const out = legs.find((l) => l.amountCents < 0)
  const inn = legs.find((l) => l.amountCents > 0)
  if (legs.length !== 2 || !out || !inn) return undefined
  return {
    linkId,
    date: out.date,
    amountCents: inn.amountCents,
    description: out.descriptionRaw,
    fromAccountId: out.accountId,
    toAccountId: inn.accountId,
    outLegId: out.id,
    inLegId: inn.id
  }
}

export function updateTransfer(db: Db, linkId: string, patch: TransferPatchInput): Transfer | undefined {
  const p = TransferPatch.parse(patch)
  return db.transaction(() => {
    const cur = getTransfer(db, linkId)
    if (!cur) return undefined
    const next = {
      fromAccountId: p.fromAccountId ?? cur.fromAccountId,
      toAccountId: p.toAccountId ?? cur.toAccountId,
      date: p.date ?? cur.date,
      amountCents: p.amountCents ?? cur.amountCents,
      description: p.description ?? cur.description
    }
    NewTransfer.parse(next)
    requireAccount(db, next.fromAccountId)
    requireAccount(db, next.toAccountId)
    updateLeg(db, cur.outLegId, {
      accountId: next.fromAccountId,
      date: next.date,
      amountCents: -next.amountCents,
      descriptionRaw: next.description
    })
    updateLeg(db, cur.inLegId, {
      accountId: next.toAccountId,
      date: next.date,
      amountCents: next.amountCents,
      descriptionRaw: next.description
    })
    return getTransfer(db, linkId)
  })()
}

export function deleteTransfer(db: Db, linkId: string): boolean {
  return softDeleteLegs(db, linkId) > 0
}
