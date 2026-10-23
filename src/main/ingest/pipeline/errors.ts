export type PipelineErrorCode =
  | 'UNSUPPORTED_FILE'
  | 'INVALID_EDIT'
  | 'UNKNOWN_ROW'
  | 'UNKNOWN_GROUP'
  | 'NOT_CSV'
  | 'SESSION_CLOSED'
  | 'COMMIT_BLOCKED'
  | 'RETAIN_DIR_REQUIRED'
  | 'NOT_FOUND'

/** Carries a code and fixed message only; never file contents or passwords. */
export class PipelineError extends Error {
  constructor(
    readonly code: PipelineErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PipelineError'
  }
}
