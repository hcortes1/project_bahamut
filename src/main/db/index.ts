import { openDatabase, type Db } from './connection'
import { migrate, type MigrateOptions, type MigrateResult } from './migrations'

export * from './connection'
export * from './errors'
export * from './migrations'
export * from './repos'
export * from './system-categories'

/** Open + migrate (with automatic pre-migration backup for existing file dbs). */
export function openAndMigrate(
  filename: string,
  opts: Omit<MigrateOptions, 'dbPath'> = {}
): { db: Db; migration: MigrateResult } {
  const db = openDatabase(filename)
  const migration = migrate(db, { ...opts, dbPath: filename })
  return { db, migration }
}
