/**
 * Categorization pipeline (instructions 8):
 * user rules -> learned rules -> built-in merchant rules -> Naive Bayes -> Uncategorized.
 */
import type { Db } from '../../db/connection'
import { getSetting } from '../../db/repos'
import { loadModel, listRules, type CategorizationRule, type NbModel } from '../../db/rules-repo'
import { UNCATEGORIZED_CATEGORY_ID } from '../../db/system-categories'
import { normalizeDescription } from '../../ingest/normalize'
import { containsPhrase, matchBuiltin } from './builtin-rules'
import { predict, tokenize } from './naive-bayes'

export const THRESHOLD_SETTING_KEY = 'import_confidence_threshold'
export const DEFAULT_REVIEW_THRESHOLD = 0.85
export const USER_RULE_CONFIDENCE = 1
export const BUILTIN_CONFIDENCE = 0.9

export type CategorizationSource = 'user_rule' | 'learned_rule' | 'builtin_rule' | 'classifier' | 'uncategorized'

export interface CategorizationResult {
  categoryId: string
  confidence: number
  source: CategorizationSource
  /** True when confidence is below the review threshold: the row must be flagged for review. */
  needsReview: boolean
  ruleId?: string
  /** Low-confidence classifier guess, offered to the reviewer but NOT applied. */
  suggestedCategoryId?: string
}

export interface CategorizerContext {
  userRules: readonly CategorizationRule[]
  learnedRules: readonly CategorizationRule[]
  model: NbModel | null
  threshold: number
}

/** Confidence of a learned rule: one correction meets the threshold; repeats raise it toward 0.99. */
export function learnedConfidence(weight: number): number {
  return Math.min(0.99, 0.85 + 0.03 * (Math.max(1, weight) - 1))
}

/** Best rule whose pattern occurs as a whole phrase: longest pattern, then highest weight. */
function bestRule(rules: readonly CategorizationRule[], normalized: string): CategorizationRule | null {
  let best: CategorizationRule | null = null
  for (const r of rules) {
    if (!containsPhrase(normalized, normalizeDescription(r.pattern))) continue
    if (
      !best ||
      r.pattern.length > best.pattern.length ||
      (r.pattern.length === best.pattern.length && r.weight > best.weight)
    )
      best = r
  }
  return best
}

/** Pure pipeline: no database access. */
export function categorizeWith(ctx: CategorizerContext, descriptionRaw: string): CategorizationResult {
  const normalized = normalizeDescription(descriptionRaw)
  const mk = (
    categoryId: string,
    confidence: number,
    source: CategorizationSource,
    extra: Partial<CategorizationResult> = {}
  ): CategorizationResult => ({
    categoryId,
    confidence,
    source,
    needsReview: confidence < ctx.threshold,
    ...extra
  })

  const user = bestRule(ctx.userRules, normalized)
  if (user) return mk(user.categoryId, USER_RULE_CONFIDENCE, 'user_rule', { ruleId: user.id })

  const learned = bestRule(ctx.learnedRules, normalized)
  if (learned) return mk(learned.categoryId, learnedConfidence(learned.weight), 'learned_rule', { ruleId: learned.id })

  const builtin = matchBuiltin(normalized)
  if (builtin) return mk(builtin.categoryId, BUILTIN_CONFIDENCE, 'builtin_rule')

  const nb = predict(ctx.model, tokenize(normalized))
  if (nb && nb.confidence >= ctx.threshold) return mk(nb.categoryId, nb.confidence, 'classifier')
  // Low confidence: do not guess. Leave Uncategorized, flagged, with the guess as a suggestion.
  return mk(UNCATEGORIZED_CATEGORY_ID, nb?.confidence ?? 0, 'uncategorized', {
    ...(nb ? { suggestedCategoryId: nb.categoryId } : {})
  })
}

/** Review threshold from settings (`import_confidence_threshold`), default 0.85. */
export function getReviewThreshold(db: Db): number {
  const raw = getSetting(db, THRESHOLD_SETTING_KEY)
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_REVIEW_THRESHOLD
}

/** Load rules, model and threshold once; reuse for a whole import batch. */
export function loadCategorizerContext(db: Db): CategorizerContext {
  return {
    userRules: listRules(db, 'user'),
    learnedRules: listRules(db, 'learned'),
    model: loadModel(db),
    threshold: getReviewThreshold(db)
  }
}

export function categorize(db: Db, descriptionRaw: string): CategorizationResult {
  return categorizeWith(loadCategorizerContext(db), descriptionRaw)
}

export function categorizeMany(db: Db, descriptions: readonly string[]): CategorizationResult[] {
  const ctx = loadCategorizerContext(db)
  return descriptions.map((d) => categorizeWith(ctx, d))
}
