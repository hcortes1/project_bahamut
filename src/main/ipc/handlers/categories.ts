import { createCategory, deleteCategory, listCategories, updateCategory } from '../../db'
import { orNotFound } from '../errors'
import type { HandlerMap } from '../context'

export const categoriesHandlers = {
  'categories.list': (ctx) => listCategories(ctx.db),
  'categories.create': (ctx, req) => createCategory(ctx.db, req),
  'categories.update': (ctx, req) => orNotFound(updateCategory(ctx.db, req.id, req.patch)),
  'categories.delete': (ctx, req) => deleteCategory(ctx.db, req.id)
} satisfies Partial<HandlerMap>
