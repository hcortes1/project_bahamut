import { deleteBudget, listBudgets, setBudget } from '../../db'
import { budgetProgress } from '../../features'
import type { HandlerMap } from '../context'

export const budgetsHandlers = {
  'budgets.list': (ctx, req) => listBudgets(ctx.db, req.month),
  'budgets.set': (ctx, req) => setBudget(ctx.db, req),
  'budgets.delete': (ctx, req) => deleteBudget(ctx.db, req.id),
  'budgets.progress': (ctx, req) => budgetProgress(ctx.db, { month: req.month, today: ctx.today() })
} satisfies Partial<HandlerMap>
