import { currentNetWorth, netWorthHistory } from '../../features'
import type { HandlerMap } from '../context'

export const netWorthHandlers = {
  'netWorth.current': (ctx, req) => currentNetWorth(ctx.db, ctx.today(), req.includeGoals),
  'netWorth.history': (ctx, req) => netWorthHistory(ctx.db, { ...req, today: ctx.today() })
} satisfies Partial<HandlerMap>
