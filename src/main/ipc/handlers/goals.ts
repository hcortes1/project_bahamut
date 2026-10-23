import {
  addContribution,
  createGoal,
  deleteContribution,
  deleteGoal,
  listContributions,
  listGoals,
  projectGoal,
  updateContribution,
  updateGoal
} from '../../features'
import { orNotFound } from '../errors'
import type { HandlerMap } from '../context'

export const goalsHandlers = {
  'goals.list': (ctx) => listGoals(ctx.db),
  'goals.create': (ctx, req) => createGoal(ctx.db, req),
  'goals.update': (ctx, req) => orNotFound(updateGoal(ctx.db, req.id, req.patch)),
  'goals.delete': (ctx, req) => deleteGoal(ctx.db, req.id),
  'goals.addContribution': (ctx, req) => addContribution(ctx.db, req),
  'goals.listContributions': (ctx, req) => listContributions(ctx.db, req.goalId),
  'goals.updateContribution': (ctx, req) => orNotFound(updateContribution(ctx.db, req.id, req.patch)),
  'goals.deleteContribution': (ctx, req) => deleteContribution(ctx.db, req.id),
  'goals.projection': (ctx, req) => projectGoal(ctx.db, req.goalId, ctx.today())
} satisfies Partial<HandlerMap>
