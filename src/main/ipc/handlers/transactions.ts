import {
  createManualTransaction,
  createTransfer,
  deleteManualTransaction,
  deleteTransfer,
  updateManualTransaction,
  updateTransfer
} from '../../features'
import { listTransactions } from '../../db'
import { orNotFound } from '../errors'
import type { HandlerMap } from '../context'

export const transactionsHandlers = {
  'transactions.list': (ctx, req) => listTransactions(ctx.db, req),
  'transactions.create': (ctx, req) => createManualTransaction(ctx.db, req),
  'transactions.update': (ctx, req) => orNotFound(updateManualTransaction(ctx.db, req.id, req.patch)),
  'transactions.delete': (ctx, req) => deleteManualTransaction(ctx.db, req.id),
  'transactions.createTransfer': (ctx, req) => createTransfer(ctx.db, req),
  'transactions.updateTransfer': (ctx, req) => orNotFound(updateTransfer(ctx.db, req.linkId, req.patch)),
  'transactions.deleteTransfer': (ctx, req) => deleteTransfer(ctx.db, req.linkId)
} satisfies Partial<HandlerMap>
