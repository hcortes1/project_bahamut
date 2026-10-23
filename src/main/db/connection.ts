import Database from 'better-sqlite3'

export type Db = Database.Database

/**
 * Open a SQLite database with foreign keys ON and WAL mode.
 * `filename` may be a file path or ':memory:' (WAL is a no-op in memory).
 */
export function openDatabase(filename: string): Db {
  const db = new Database(filename)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  return db
}
