import {
  createRecurring,
  deleteRecurring,
  listDueSoon,
  listRecurring,
  markRecurringPaid,
  updateRecurring
} from '../../features'
import { orNotFound } from '../errors'
import type { HandlerMap } from '../context'

export const recurringHandlers = {
  'recurring.list': (ctx, req) => listRecurring(ctx.db, req.status),
  'recurring.create': (ctx, req) => createRecurring(ctx.db, req),
  'recurring.update': (ctx, req) => orNotFound(updateRecurring(ctx.db, req.id, req.patch)),
  'recurring.delete': (ctx, req) => deleteRecurring(ctx.db, req.id),
  'recurring.markPaid': (ctx, req) => markRecurringPaid(ctx.db, req.id),
  'recurring.dueSoon': (ctx, req) => listDueSoon(ctx.db, ctx.today(), req.withinDays)
} satisfies Partial<HandlerMap>
