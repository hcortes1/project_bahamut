import { incomeVsExpensesByMonth, spendingByCategory, spendingByMonth, spendingTransactions, topMerchants } from '../../db'
import type { HandlerMap } from '../context'

export const dashboardHandlers = {
  'dashboard.spendingByMonth': (ctx, req) => {
    const current = ctx.today().slice(0, 7)
    return spendingByMonth(ctx.db, req).map((m) => ({ ...m, partial: m.month === current }))
  },

  // Trailing average of net spending over up to `window` months ending at each point.
  'dashboard.trend': (ctx, req) => {
    const window = req.window ?? 3
    const current = ctx.today().slice(0, 7)
    const months = spendingByMonth(ctx.db, req.filter)
    return {
      window,
      points: months.map((m, i) => {
        const slice = months.slice(Math.max(0, i - window + 1), i + 1)
        const sum = slice.reduce((s, x) => s + x.expenseCents, 0)
        return {
          month: m.month,
          expenseCents: m.expenseCents,
          trailingAverageCents: Math.round(sum / slice.length),
          partial: m.month === current
        }
      })
    }
  },

  'dashboard.incomeVsExpenses': (ctx, req) => {
    const current = ctx.today().slice(0, 7)
    return incomeVsExpensesByMonth(ctx.db, req).map((m) => ({
      ...m,
      netCents: m.incomeCents - m.expenseCents,
      partial: m.month === current
    }))
  },

  'dashboard.byCategory': (ctx, req) => spendingByCategory(ctx.db, req),
  'dashboard.topMerchants': (ctx, req) => topMerchants(ctx.db, req.filter, req.limit),
  'dashboard.drillDown': (ctx, req) => spendingTransactions(ctx.db, req.filter, req.categoryId, req.limit, req.offset)
} satisfies Partial<HandlerMap>
