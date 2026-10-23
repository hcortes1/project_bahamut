/**
 * Multinomial Naive Bayes over description tokens with Laplace (add-one)
 * smoothing. Pure functions; the model is a plain serializable object
 * (see NbModel in db/rules-repo.ts). Trained only on user-corrected data.
 */
import { emptyModel, type NbModel } from '../../db/rules-repo'

/** Below this many training documents the classifier abstains (cold start). */
export const MIN_TRAINING_DOCS = 3

/** Alphabetic tokens (len >= 2) of an already-normalized description, deduplicated. */
export function tokenize(normalized: string): string[] {
  const out = new Set<string>()
  for (const t of normalized.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (t.length >= 2 && !/^\d+$/.test(t)) out.add(t)
  }
  return [...out]
}

const key = (t: string): string => 't:' + t
const own = (o: Record<string, number>, k: string): number => (Object.hasOwn(o, k) ? (o[k] ?? 0) : 0)

/** Returns a new model with one more training document. Does not mutate the input. */
export function train(model: NbModel | null, categoryId: string, tokens: readonly string[]): NbModel {
  const m: NbModel = structuredClone(model ?? emptyModel())
  const uniq = [...new Set(tokens)]
  if (uniq.length === 0) return m
  m.docs += 1
  m.classDocs[categoryId] = own(m.classDocs, categoryId) + 1
  const counts = (m.tokenCounts[categoryId] ??= {})
  for (const t of uniq) {
    const k = key(t)
    counts[k] = own(counts, k) + 1
    m.classTokens[categoryId] = own(m.classTokens, categoryId) + 1
    m.vocab[k] = own(m.vocab, k) + 1
  }
  return m
}

export interface NbPrediction {
  categoryId: string
  /** Posterior of the top class, scaled by the fraction of tokens the model has seen. */
  confidence: number
}

/** Predict, or return null when the model cannot say anything (cold start, no known tokens). */
export function predict(model: NbModel | null, tokens: readonly string[]): NbPrediction | null {
  if (!model || model.docs < MIN_TRAINING_DOCS) return null
  const uniq = [...new Set(tokens)]
  const known = uniq.filter((t) => Object.hasOwn(model.vocab, key(t)))
  if (known.length === 0) return null
  const vocabSize = Object.keys(model.vocab).length
  const classes = Object.keys(model.classDocs)
  if (classes.length === 0) return null

  const logs = classes.map((c) => {
    const counts = model.tokenCounts[c] ?? {}
    const total = own(model.classTokens, c)
    let lp = Math.log(own(model.classDocs, c) / model.docs)
    for (const t of known) lp += Math.log((own(counts, key(t)) + 1) / (total + vocabSize))
    return lp
  })
  const max = Math.max(...logs)
  const exps = logs.map((l) => Math.exp(l - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  let bi = 0
  for (let i = 1; i < exps.length; i++) if ((exps[i] ?? 0) > (exps[bi] ?? 0)) bi = i
  const posterior = (exps[bi] ?? 0) / sum
  const coverage = known.length / uniq.length
  return { categoryId: classes[bi] as string, confidence: posterior * coverage }
}
