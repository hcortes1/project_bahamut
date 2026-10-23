import type { Db } from '../../db/connection'
import {
  deleteRule,
  getRule,
  listRules,
  updateRule,
  type CategorizationRule,
  type RulePatchInput
} from '../../db/rules-repo'

export * from './builtin-rules'
export * from './naive-bayes'
export * from './pipeline'
export * from './learning'

/** Settings screen: view learned rules. */
export const listLearnedRules = (db: Db): CategorizationRule[] => listRules(db, 'learned')

/** Settings screen: edit a learned rule (pattern, category, weight). */
export function editLearnedRule(db: Db, id: string, patch: RulePatchInput): CategorizationRule | undefined {
  const r = getRule(db, id)
  return r && r.source === 'learned' ? updateRule(db, id, patch) : undefined
}

/** Settings screen: delete a learned rule. */
export function deleteLearnedRule(db: Db, id: string): boolean {
  const r = getRule(db, id)
  return r !== undefined && r.source === 'learned' && deleteRule(db, id)
}
