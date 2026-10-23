import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Db } from '../db'

/** Delete retained imports, backups and finally the database (+ WAL/SHM), so a failure leaves the db intact. Close the DB first. */
export function deleteDataFiles(dbPath: string, retainDir: string): void {
  rmSync(retainDir, { recursive: true, force: true })
  rmSync(join(dirname(dbPath), 'backups'), { recursive: true, force: true })
  for (const suffix of ['-wal', '-shm', '']) rmSync(dbPath + suffix, { force: true })
}

export interface ResetDeps {
  dbPath: string
  retainDir: string
  db: Db
  /** Receives the freshly opened handle (also called after a failed delete, with the reopened old db). */
  setDb(db: Db): void
  open(dbPath: string): Db
  /** The database could not be reopened at all. */
  onFatal(): void
  remove?: (dbPath: string, retainDir: string) => void
}

/**
 * Close the db, delete its files, reopen. The reopen ALWAYS happens, even when deleting fails, so the
 * caller's rollback (restoring the auth record) has a live database and a failed wipe never leaves data
 * without credentials. The deletion error is rethrown after the reopen.
 */
export function resetDatabase(d: ResetDeps): void {
  let failed = false
  let failure: unknown
  try {
    d.db.close()
    ;(d.remove ?? deleteDataFiles)(d.dbPath, d.retainDir)
  } catch (e) {
    failed = true
    failure = e
  }
  try {
    d.setDb(d.open(d.dbPath))
  } catch (e) {
    d.onFatal()
    throw e
  }
  if (failed) throw failure
}
