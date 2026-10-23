import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Db } from '../../db'
import { createImport, createTransaction } from '../../db'
import { isRowIncluded } from './duplicates'
import { PipelineError } from './errors'
import { getCommitBlockers } from './review'
import { assertOpen, readRetainDefault } from './session'
import type { CommitOptions, CommitResult, ReviewSession } from './types'

/**
 * Write the import in ONE SQLite transaction: the imports row plus all included transactions.
 * Throws PipelineError('COMMIT_BLOCKED') if the review is incomplete. Any failure rolls back
 * everything and removes a retained copy that was already written.
 */
export function commitImport(db: Db, session: ReviewSession, opts: CommitOptions = {}): CommitResult {
  assertOpen(session)
  const blockers = getCommitBlockers(session)
  if (blockers.codes.length > 0) {
    throw new PipelineError('COMMIT_BLOCKED', `Review is incomplete: ${blockers.codes.join(', ')}.`)
  }
  const keep = opts.keepSourceFile ?? readRetainDefault(db)
  if (keep && !opts.retainDir) {
    throw new PipelineError('RETAIN_DIR_REQUIRED', 'A retention directory is required to keep the source file.')
  }

  const included = session.rows.filter((r) => isRowIncluded(session, r))
  const skippedDuplicates = session.rows.filter(
    (r) => !r.excluded && r.duplicateGroupId !== null && !isRowIncluded(session, r)
  ).length
  let retainedPath: string | null = null
  try {
    const result = db.transaction((): CommitResult => {
      const imp = createImport(db, {
        fileName: session.fileName,
        fileType: session.fileType,
        fileHash: session.fileHash,
        rowCount: included.length
      })
      for (const r of included) {
        createTransaction(db, {
          accountId: session.accountId,
          date: r.date,
          amountCents: r.amountCents,
          descriptionRaw: r.description,
          descriptionNormalized: r.descriptionNormalized,
          categoryId: r.categoryId,
          importId: imp.id,
          fingerprint: r.fingerprint,
          source: r.source,
          confidence: r.confidence
        })
      }
      if (keep && opts.retainDir) {
        mkdirSync(opts.retainDir, { recursive: true })
        retainedPath = join(opts.retainDir, `${imp.id}${extname(session.fileName).toLowerCase()}`)
        writeFileSync(retainedPath, session.bytes)
        db.prepare('UPDATE imports SET retained_file_path=?, updated_at=? WHERE id=?').run(
          retainedPath,
          new Date().toISOString(),
          imp.id
        )
      }
      return {
        importId: imp.id,
        inserted: included.length,
        skippedDuplicates,
        excluded: session.rows.filter((r) => r.excluded).length,
        retainedFilePath: retainedPath
      }
    })()
    session.status = 'committed'
    session.bytes = new Uint8Array(0)
    return result
  } catch (e) {
    if (retainedPath) rmSync(retainedPath, { force: true })
    throw e
  }
}
