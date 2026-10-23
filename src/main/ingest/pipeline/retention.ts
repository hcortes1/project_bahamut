import { rmSync } from 'node:fs'
import type { Db } from '../../db'
import { deleteImport, getImport } from '../../db'
import { PipelineError } from './errors'

export interface DeleteRetainedResult {
  fileDeleted: boolean
  transactionsDeleted: number
}

/**
 * Delete the retained source file of an import. `alsoDeleteTransactions` has no default on purpose:
 * the caller must ask the user separately and pass their answer. When false, transactions are untouched.
 * When true, the import's transactions and the import record are soft-deleted (deleted_at), atomically.
 */
export function deleteRetainedFile(db: Db, importId: string, alsoDeleteTransactions: boolean): DeleteRetainedResult {
  const imp = getImport(db, importId)
  if (!imp) throw new PipelineError('NOT_FOUND', 'No such import.')
  if (imp.retainedFilePath) rmSync(imp.retainedFilePath, { force: true })
  const now = new Date().toISOString()
  return db.transaction((): DeleteRetainedResult => {
    db.prepare('UPDATE imports SET retained_file_path=NULL, updated_at=? WHERE id=?').run(now, importId)
    let transactionsDeleted = 0
    if (alsoDeleteTransactions) {
      transactionsDeleted = db
        .prepare('UPDATE transactions SET deleted_at=?, updated_at=? WHERE import_id=? AND deleted_at IS NULL')
        .run(now, now, importId).changes
      deleteImport(db, importId)
    }
    return { fileDeleted: imp.retainedFilePath !== null, transactionsDeleted }
  })()
}
