import { Worker } from 'node:worker_threads'
import type { OptimizeRequest, OptimizeResponse } from '../analysis/optimizer/request'
import type { OptimizerInput, OptimizerResult } from '../analysis/optimizer'
import { IpcFailure } from './errors'

export const OPTIMIZER_TIMEOUT_MS = 120_000

/**
 * One fresh worker thread per run, terminated as soon as it answers, fails or times out. A second run
 * while one is in flight is refused with CONFLICT.
 */
export function createOptimizerRunner(
  workerPath: string,
  timeoutMs = OPTIMIZER_TIMEOUT_MS
): (input: OptimizerInput) => Promise<OptimizerResult> {
  let running = false
  return (input) => {
    if (running) return Promise.reject(new IpcFailure('CONFLICT', 'The optimizer is already running.'))
    running = true
    return new Promise((resolve, reject) => {
      const fail = (): IpcFailure => new IpcFailure('OPTIMIZER_FAILED', 'The optimizer could not complete.')
      let worker: Worker
      try {
        worker = new Worker(workerPath, { name: 'flujo-optimizer' })
      } catch {
        running = false
        reject(fail())
        return
      }
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        running = false
        clearTimeout(timer)
        void worker.terminate()
        fn()
      }
      const timer = setTimeout(() => finish(() => reject(fail())), timeoutMs)
      worker.once('message', (res: OptimizeResponse) => finish(() => (res.ok ? resolve(res.result) : reject(fail()))))
      worker.once('error', () => finish(() => reject(fail())))
      worker.once('exit', () => finish(() => reject(fail())))
      const req: OptimizeRequest = { id: 1, input }
      worker.postMessage(req)
    })
  }
}
