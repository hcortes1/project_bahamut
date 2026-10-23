import { applyRecategorize, deleteLearnedRule, editLearnedRule, listLearnedRules, recordCorrection } from '../../analysis/categorizer'
import { getTransaction } from '../../db'
import { orNotFound } from '../errors'
import type { HandlerMap } from '../context'

export const categorizerHandlers = {
  'categorizer.listLearnedRules': (ctx) => listLearnedRules(ctx.db),
  'categorizer.editLearnedRule': (ctx, req) => orNotFound(editLearnedRule(ctx.db, req.id, req.patch)),
  'categorizer.deleteLearnedRule': (ctx, req) => deleteLearnedRule(ctx.db, req.id),
  'categorizer.recordCorrection': (ctx, req) =>
    recordCorrection(ctx.db, orNotFound(getTransaction(ctx.db, req.transactionId)), req.categoryId),
  'categorizer.reapply': (ctx, req) => ({ changed: applyRecategorize(ctx.db, req.transactionIds, req.categoryId) })
} satisfies Partial<HandlerMap>
