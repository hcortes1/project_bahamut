/** Learning from corrections (instructions 8). */
import type { Db } from '../../db/connection'
import { listTransactions, updateTransaction } from '../../db/repos'
import {
  createRule,
  findRuleByPattern,
  listRules,
  loadModel,
  saveModel,
  updateRule,
  type CategorizationRule
} from '../../db/rules-repo'
import { normalizeDescription } from '../../ingest/normalize'
import type { Transaction } from '@shared/db-types'
import { containsPhrase } from './builtin-rules'
import { train, tokenize } from './naive-bayes'

export type CorrectedTxn = Pick<Transaction, 'id' | 'descriptionRaw' | 'descriptionNormalized' | 'merchant'>

export interface CorrectionResult {
  /** The learned rule created or strengthened (or the user rule updated when one has the same pattern). */
  rule: CategorizationRule
  created: boolean
  /** Other existing transactions from the same merchant not yet in the new category: offer to re-apply. */
  reapplyCandidates: Transaction[]
  /** A user rule with a different category that outranks learned rules for this merchant, if any. */
  shadowedByUserRule: CategorizationRule | null
}

export const merchantKey = (t: CorrectedTxn): string =>
  (t.descriptionNormalized && t.descriptionNormalized.trim() !== ''
    ? t.descriptionNormalized
    : normalizeDescription(t.descriptionRaw)
  ).toUpperCase()

/**
 * Record a user correction, atomically:
 *  1. create/strengthen the learned rule for the normalized merchant (a different
 *     category replaces the old one and resets weight to 1);
 *  2. set the transaction itself to the new category (confidence 1) if it is stored;
 *  3. feed the classifier (training on the correction);
 *  4. return other transactions from that merchant offered for re-apply.
 */
export function recordCorrection(db: Db, txn: CorrectedTxn, newCategoryId: string): CorrectionResult {
  const key = merchantKey(txn)
  return db.transaction((): CorrectionResult => {
    let rule: CategorizationRule
    let created = false
    const userSame = findRuleByPattern(db, key, 'user')
    if (userSame) {
      rule = userSame.categoryId === newCategoryId ? userSame : (updateRule(db, userSame.id, { categoryId: newCategoryId }) as CategorizationRule)
    } else {
      const existing = findRuleByPattern(db, key, 'learned')
      if (!existing) {
        rule = createRule(db, { pattern: key, categoryId: newCategoryId, source: 'learned', weight: 1 })
        created = true
      } else if (existing.categoryId === newCategoryId) {
        rule = updateRule(db, existing.id, { weight: existing.weight + 1 }) as CategorizationRule
      } else {
        rule = updateRule(db, existing.id, { categoryId: newCategoryId, weight: 1 }) as CategorizationRule
      }
    }

    updateTransaction(db, txn.id, { categoryId: newCategoryId, confidence: 1 })
    saveModel(db, train(loadModel(db), newCategoryId, tokenize(key)))

    const shadowedByUserRule =
      listRules(db, 'user').find(
        (r) => r.categoryId !== newCategoryId && containsPhrase(key, normalizeDescription(r.pattern))
      ) ?? null

    return { rule, created, reapplyCandidates: findReapplyCandidates(db, txn, newCategoryId), shadowedByUserRule }
  })()
}

/** Other live transactions with the same normalized merchant that are not in `categoryId`. */
export function findReapplyCandidates(db: Db, txn: CorrectedTxn, categoryId: string): Transaction[] {
  const key = merchantKey(txn)
  return listTransactions(db).filter(
    (t) =>
      t.id !== txn.id &&
      t.categoryId !== categoryId &&
      merchantKey(t).toUpperCase() === key
  )
}

/** Apply a category to many transactions (the re-apply offer). Returns how many changed. */
export function applyRecategorize(db: Db, ids: readonly string[], categoryId: string): number {
  return db.transaction(() => {
    let n = 0
    for (const id of ids) {
      if (updateTransaction(db, id, { categoryId, confidence: 1 })) n++
    }
    return n
  })()
}
