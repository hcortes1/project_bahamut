import { ZodError } from 'zod'
import { KNOWN_ERROR_CODES, type IpcError } from '@shared/ipc'
import { DbError } from '../db/errors'
import { FeatureError } from '../features/common'
import { PdfIngestError } from '../ingest/pdf/errors'
import { PipelineError } from '../ingest/pipeline/errors'

export { KNOWN_ERROR_CODES }
export type { IpcError }

/** Thrown by IPC handlers/gates. Message must be a fixed string. */
export class IpcFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: { fileName?: string; page?: number | null } = {}
  ) {
    super(message)
    this.name = 'IpcFailure'
  }
}

export const notFound = (): IpcFailure => new IpcFailure('NOT_FOUND', 'Not found.')

/** Unwrap a repo result, throwing NOT_FOUND for undefined. */
export function orNotFound<T>(v: T | undefined): T {
  if (v === undefined) throw notFound()
  return v
}

/** Map anything thrown to a fixed, safe error. Never forwards an arbitrary error message. */
export function toIpcError(e: unknown): IpcError {
  if (e instanceof IpcFailure) return { code: e.code, message: e.message, ...e.extra }
  if (e instanceof PdfIngestError) return { code: e.code, message: e.reason, fileName: e.fileName, page: e.page }
  if (e instanceof PipelineError) return { code: e.code, message: e.message }
  if (e instanceof FeatureError || e instanceof DbError) {
    return { code: e.code, message: 'The request could not be completed.' }
  }
  if (e instanceof ZodError) return { code: 'INVALID_PAYLOAD', message: 'Invalid request.' }
  const sqliteCode = (e as { code?: unknown } | null)?.code
  if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
    return { code: 'CONFLICT', message: 'The change conflicts with existing data.' }
  }
  return { code: 'INTERNAL', message: 'Something went wrong.' }
}
