import type { IpcError, Result } from '@shared/ipc'

/** Thrown when a channel resolves to `{ ok: false }`. The message is the fixed, safe text from main. */
export class ApiError extends Error {
  readonly code: string
  readonly fileName?: string
  readonly page?: number | null
  constructor(e: IpcError) {
    super(e.message)
    this.name = 'ApiError'
    this.code = e.code
    this.fileName = e.fileName
    this.page = e.page
  }
}

/** Unwrap a `Result<T>`: return the data, or throw an ApiError. */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const r = await call
  if (r.ok) return r.data
  throw new ApiError(r.error)
}

/** Text safe to show the user. Never includes anything but the fixed IPC message. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const where = e.fileName ? `${e.fileName}${typeof e.page === 'number' ? `, page ${e.page}` : ''}: ` : ''
    return where + e.message
  }
  return 'Something went wrong. Try again.'
}
