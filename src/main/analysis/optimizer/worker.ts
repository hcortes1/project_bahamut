import { parentPort } from 'node:worker_threads'
import { handleOptimizeRequest, type OptimizeRequest } from './request'

// Worker entry: one request in, one response out per message. Bundle as its own electron-vite entry.
parentPort?.on('message', (req: OptimizeRequest) => {
  parentPort?.postMessage(handleOptimizeRequest(req))
})
