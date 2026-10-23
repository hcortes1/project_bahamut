import type { HandlerMap } from '../context'
import { accountsHandlers } from './accounts'
import { authHandlers } from './auth'
import { budgetsHandlers } from './budgets'
import { categoriesHandlers } from './categories'
import { categorizerHandlers } from './categorizer'
import { dashboardHandlers } from './dashboard'
import { dataHandlers } from './data'
import { exportHandlers } from './export'
import { goalsHandlers } from './goals'
import { importsHandlers } from './imports'
import { netWorthHandlers } from './netWorth'
import { optimizerHandlers } from './optimizer'
import { recurringHandlers } from './recurring'
import { settingsHandlers } from './settings'
import { transactionsHandlers } from './transactions'

/** Typed against the channel table: a missing channel fails tsc here; an extra one fails in its domain file. */
export const handlers: HandlerMap = {
  ...authHandlers,
  ...settingsHandlers,
  ...accountsHandlers,
  ...transactionsHandlers,
  ...categoriesHandlers,
  ...budgetsHandlers,
  ...importsHandlers,
  ...dashboardHandlers,
  ...recurringHandlers,
  ...goalsHandlers,
  ...netWorthHandlers,
  ...optimizerHandlers,
  ...categorizerHandlers,
  ...exportHandlers,
  ...dataHandlers
}
