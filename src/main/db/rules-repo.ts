/**
 * Repository for categorization rules and the persisted Naive Bayes model
 * (instructions 8). Not re-exported from db/index.ts; import directly.
 *
 * Schema choices (no migration needed):
 * - Rules live in `categorization_rules` (pattern, category_id, source, weight).
 *   Built-in merchant rules ship in code and are NOT seeded into the table.
 *   Patterns are stored uppercase, already normalized.
 * - The classifier model is one JSON document in the `settings` table under
 *   key `categorizer_nb_model` (a small, user-data-only model; avoids a new table).
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from './connection'
import { assertLiveCategory, getSetting, setSetting } from './repos'

export const RuleSource = z.enum(['system', 'learned', 'user'])
export type RuleSource = z.infer<typeof RuleSource>

export const CategorizationRule = z.object({
  id: z.string(),
  pattern: z.string(),
  categoryId: z.string(),
  source: RuleSource,
  weight: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable()
})
export type CategorizationRule = z.infer<typeof CategorizationRule>

export const NewRule = z.object({
  pattern: z.string().trim().min(1),
  categoryId: z.string().min(1),
  source: RuleSource,
  weight: z.number().positive().default(1)
})
export type NewRuleInput = z.input<typeof NewRule>

export const RulePatch = z
  .object({
    pattern: z.string().trim().min(1),
    categoryId: z.string().min(1),
    weight: z.number().positive()
  })
  .partial()
export type RulePatchInput = z.input<typeof RulePatch>

const now = (): string => new Date().toISOString()
const normPattern = (p: string): string => p.trim().toUpperCase().replace(/\s+/g, ' ')

interface RuleRow {
  id: string
  pattern: string
  category_id: string
  source: string
  weight: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function fromRow(r: RuleRow): CategorizationRule {
  return CategorizationRule.parse({
    id: r.id,
    pattern: r.pattern,
    categoryId: r.category_id,
    source: r.source,
    weight: r.weight,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at
  })
}

export function createRule(db: Db, input: NewRuleInput): CategorizationRule {
  const v = NewRule.parse(input)
  assertLiveCategory(db, v.categoryId)
  const id = randomUUID()
  const t = now()
  db.prepare(
    `INSERT INTO categorization_rules (id,pattern,category_id,source,weight,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, normPattern(v.pattern), v.categoryId, v.source, v.weight, t, t)
  return getRule(db, id) as CategorizationRule
}

export function getRule(db: Db, id: string, includeDeleted = false): CategorizationRule | undefined {
  const r = db
    .prepare(`SELECT * FROM categorization_rules WHERE id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`)
    .get(id) as RuleRow | undefined
  return r ? fromRow(r) : undefined
}

/** Live rules, optionally filtered by source. Highest weight first, then pattern. */
export function listRules(db: Db, source?: RuleSource): CategorizationRule[] {
  const rows = (
    source
      ? db
          .prepare(
            'SELECT * FROM categorization_rules WHERE deleted_at IS NULL AND source=? ORDER BY weight DESC, pattern'
          )
          .all(source)
      : db
          .prepare('SELECT * FROM categorization_rules WHERE deleted_at IS NULL ORDER BY weight DESC, pattern')
          .all()
  ) as RuleRow[]
  return rows.map(fromRow)
}

export function findRuleByPattern(db: Db, pattern: string, source: RuleSource): CategorizationRule | undefined {
  const r = db
    .prepare(
      'SELECT * FROM categorization_rules WHERE deleted_at IS NULL AND source=? AND pattern=? ORDER BY created_at LIMIT 1'
    )
    .get(source, normPattern(pattern)) as RuleRow | undefined
  return r ? fromRow(r) : undefined
}

export function updateRule(db: Db, id: string, patch: RulePatchInput): CategorizationRule | undefined {
  const cur = getRule(db, id)
  if (!cur) return undefined
  const p = RulePatch.parse(patch)
  if (p.categoryId !== undefined) assertLiveCategory(db, p.categoryId)
  db.prepare(
    'UPDATE categorization_rules SET pattern=?, category_id=?, weight=?, updated_at=? WHERE id=?'
  ).run(
    p.pattern !== undefined ? normPattern(p.pattern) : cur.pattern,
    p.categoryId ?? cur.categoryId,
    p.weight ?? cur.weight,
    now(),
    id
  )
  return getRule(db, id)
}

/** Soft delete. Returns true if a live rule was deleted. */
export function deleteRule(db: Db, id: string): boolean {
  const t = now()
  return (
    db
      .prepare('UPDATE categorization_rules SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL')
      .run(t, t, id).changes > 0
  )
}

// ------------------------------------------------------------ classifier model
export const MODEL_SETTING_KEY = 'categorizer_nb_model'

/** Serializable Naive Bayes model. Token keys are prefixed "t:" to avoid prototype-key collisions. */
export const NbModel = z.object({
  v: z.literal(1),
  docs: z.number().int().nonnegative(),
  classDocs: z.record(z.string(), z.number().int().nonnegative()),
  classTokens: z.record(z.string(), z.number().int().nonnegative()),
  tokenCounts: z.record(z.string(), z.record(z.string(), z.number().int().positive())),
  vocab: z.record(z.string(), z.number().int().positive())
})
export type NbModel = z.infer<typeof NbModel>

export function emptyModel(): NbModel {
  return { v: 1, docs: 0, classDocs: {}, classTokens: {}, tokenCounts: {}, vocab: {} }
}

/** Load the persisted model, or null if none (cold start) or if it is unreadable. */
export function loadModel(db: Db): NbModel | null {
  const raw = getSetting(db, MODEL_SETTING_KEY)
  if (raw === undefined) return null
  try {
    return NbModel.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveModel(db: Db, model: NbModel): void {
  setSetting(db, MODEL_SETTING_KEY, JSON.stringify(NbModel.parse(model)))
}

export function clearModel(db: Db): void {
  db.prepare('DELETE FROM settings WHERE key=?').run(MODEL_SETTING_KEY)
}
