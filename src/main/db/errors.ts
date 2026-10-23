/** Typed database-layer error. `code` is stable and safe to show; messages never contain financial data. */
export type DbErrorCode =
  | 'DB_NEWER_THAN_APP'
  | 'BACKUP_FAILED'
  | 'ACCOUNT_NOT_FOUND'
  | 'CATEGORY_NOT_FOUND'
  | 'SYSTEM_CATEGORY_IMMUTABLE'
  | 'CATEGORY_CYCLE'
  | 'AUTH_RECORD_CORRUPT'

export class DbError extends Error {
  constructor(
    public readonly code: DbErrorCode,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'DbError'
  }
}
