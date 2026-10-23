import {
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount
} from '../../db'
import { deleteBalance, listBalances, recordBalance } from '../../features'
import { orNotFound } from '../errors'
import type { HandlerMap } from '../context'

export const accountsHandlers = {
  'accounts.list': (ctx) => listAccounts(ctx.db),
  'accounts.create': (ctx, req) => createAccount(ctx.db, req),
  'accounts.update': (ctx, req) => orNotFound(updateAccount(ctx.db, req.id, req.patch)),
  'accounts.delete': (ctx, req) => deleteAccount(ctx.db, req.id),
  'accounts.recordBalance': (ctx, req) => recordBalance(ctx.db, req),
  'accounts.listBalances': (ctx, req) => listBalances(ctx.db, req),
  'accounts.deleteBalance': (ctx, req) => deleteBalance(ctx.db, req.id)
} satisfies Partial<HandlerMap>
