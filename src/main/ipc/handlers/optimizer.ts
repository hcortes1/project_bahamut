import { loadOptimizerInput, listFlags, listSubscriptionRecords, markFlagLegitimate, markFlagSuspicious, persistFlags, persistSubscriptions, setSubscriptionStatus } from '../../db/analysis-repo'
import type { OptimizerResultDto } from '@shared/ipc'
import { setBudget } from '../../db'
import { IpcFailure, notFound } from '../errors'
import type { HandlerMap } from '../context'

export const optimizerHandlers = {
  'optimizer.run': async (ctx) => {
    const result = await ctx.runOptimizer(loadOptimizerInput(ctx.db, ctx.today()))
    if (ctx.session.isLocked) throw new IpcFailure('LOCKED', 'The app is locked.')
    ctx.lastOptimizer = result
    if (result.eligibility.eligible && 'subscriptions' in result) {
      const subIds = persistSubscriptions(ctx.db, result.subscriptions)
      const flagIds = persistFlags(ctx.db, result.flags)
      return {
        ...result,
        subscriptions: result.subscriptions.map((s, i) => ({ ...s, recordId: subIds[i] as string })),
        flags: result.flags.map((f, i) => ({ ...f, recordId: flagIds[i] as string }))
      }
    }
    return result as OptimizerResultDto
  },
  'optimizer.listSubscriptions': (ctx) => listSubscriptionRecords(ctx.db),
  'optimizer.confirmSubscription': (ctx, req) => setSubscriptionStatus(ctx.db, req.id, 'confirmed'),
  'optimizer.rejectSubscription': (ctx, req) => setSubscriptionStatus(ctx.db, req.id, 'rejected'),
  'optimizer.listFlags': (ctx, req) => listFlags(ctx.db, req.status),
  'optimizer.markFlagLegitimate': (ctx, req) => markFlagLegitimate(ctx.db, req.id),
  'optimizer.markFlagSuspicious': (ctx, req) => markFlagSuspicious(ctx.db, req.id),

  // The amount is taken from main's copy of the last run; the renderer only names the category and month.
  'optimizer.acceptSuggestedBudget': (ctx, req) => {
    const last = ctx.lastOptimizer
    const suggestion = last && 'suggestedBudgets' in last ? last.suggestedBudgets.find((s) => s.categoryId === req.categoryId) : undefined
    if (!suggestion) throw notFound()
    return setBudget(ctx.db, { categoryId: req.categoryId, month: req.month, amountCents: suggestion.suggestedCents })
  }
} satisfies Partial<HandlerMap>
