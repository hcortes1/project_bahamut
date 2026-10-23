import { parentPort } from 'node:worker_threads'
import { handleParseRequest, type ParseRequest } from './request'

// Worker entry: one request in, one response out. Bundle as its own electron-vite/rollup entry
// (e.g. `new Worker(new URL('./pdf-worker.js', import.meta.url))` against the built file).
// Spawn a fresh worker per file so a password never outlives the parse it was given for.
parentPort?.on('message', (req: ParseRequest) => {
  void handleParseRequest(req).then((res) => parentPort?.postMessage(res))
})
