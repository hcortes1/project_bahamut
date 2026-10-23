import { runOptimizer } from './index'
import type { OptimizerInput, OptimizerResult } from './types'

export interface OptimizeRequest {
  id: number
  input: OptimizerInput
}

export type OptimizeResponse =
  | { id: number; ok: true; result: OptimizerResult }
  | { id: number; ok: false; error: { code: 'OPTIMIZER_FAILED' } }

/** Worker-side handler. Never echoes input data in errors (no financial data in logs/messages). */
export function handleOptimizeRequest(req: OptimizeRequest): OptimizeResponse {
  try {
    return { id: req.id, ok: true, result: runOptimizer(req.input) }
  } catch {
    return { id: req.id, ok: false, error: { code: 'OPTIMIZER_FAILED' } }
  }
}
