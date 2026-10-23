import type { Db } from '../db/connection'
import { DbError } from '../db/errors'
import { assertSafeParams } from './credentials'
import type { AuthRecord, AuthStore, StoredCredential } from './store'

/** Columns of the `auth` table (migration 2): one row, id = 1. */
interface AuthRow {
  pin_hash: string | null
  pin_salt: string | null
  pin_key_length: number | null
  pin_cost: number | null
  pin_block_size: number | null
  pin_parallelization: number | null
  password_hash: string | null
  password_salt: string | null
  password_key_length: number | null
  password_cost: number | null
  password_block_size: number | null
  password_parallelization: number | null
  failure_count: number
  lockout_until: number
}

type Prefix = 'pin' | 'password'

function readCredential(row: AuthRow, p: Prefix): StoredCredential | null {
  const hash = row[`${p}_hash`]
  if (hash === null) return null
  const cred: StoredCredential = {
    algorithm: 'scrypt',
    hash,
    salt: row[`${p}_salt`] as string,
    keyLength: row[`${p}_key_length`] as number,
    cost: row[`${p}_cost`] as number,
    blockSize: row[`${p}_block_size`] as number,
    parallelization: row[`${p}_parallelization`] as number
  }
  if (typeof cred.salt !== 'string' || typeof cred.hash !== 'string') throw new DbError('AUTH_RECORD_CORRUPT')
  assertSafeParams(cred)
  return cred
}

const credColumns = (c: StoredCredential | null): (string | number | null)[] =>
  c ? [c.hash, c.salt, c.keyLength, c.cost, c.blockSize, c.parallelization] : [null, null, null, null, null, null]

/**
 * AuthStore over the single-row `auth` table (id = 1): per-credential hash, salt and scrypt
 * parameters as typed columns, plus failure_count and lockout_until (epoch ms). CHECK constraints
 * guarantee at least one credential and all-or-nothing credential columns. Only hashes and salts are
 * stored, never plaintext. Unreadable state throws instead of silently unlocking.
 */
export class SqliteAuthStore implements AuthStore {
  constructor(private readonly db: Db) {}

  get(): AuthRecord | null {
    const row = this.db.prepare('SELECT * FROM auth WHERE id = 1').get() as AuthRow | undefined
    if (!row) return null
    try {
      const pin = readCredential(row, 'pin')
      const password = readCredential(row, 'password')
      if (!pin && !password) throw new DbError('AUTH_RECORD_CORRUPT')
      return {
        pin,
        password,
        failureCount: row.failure_count,
        lockoutUntil: row.lockout_until
      }
    } catch (e) {
      if (e instanceof DbError) throw e
      throw new DbError('AUTH_RECORD_CORRUPT')
    }
  }

  set(record: AuthRecord | null): void {
    if (record === null) {
      this.db.prepare('DELETE FROM auth').run()
      return
    }
    if (!record.pin && !record.password) throw new DbError('AUTH_RECORD_CORRUPT')
    for (const c of [record.pin, record.password]) if (c) assertSafeParams(c)
    if (!Number.isInteger(record.failureCount) || record.failureCount < 0) throw new RangeError('failureCount')
    if (!Number.isFinite(record.lockoutUntil) || record.lockoutUntil < 0) throw new RangeError('lockoutUntil')
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO auth (id, pin_hash, pin_salt, pin_key_length, pin_cost, pin_block_size, pin_parallelization,
           password_hash, password_salt, password_key_length, password_cost, password_block_size, password_parallelization,
           failure_count, lockout_until, created_at, updated_at)
         VALUES (1, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           pin_hash=excluded.pin_hash, pin_salt=excluded.pin_salt, pin_key_length=excluded.pin_key_length,
           pin_cost=excluded.pin_cost, pin_block_size=excluded.pin_block_size,
           pin_parallelization=excluded.pin_parallelization,
           password_hash=excluded.password_hash, password_salt=excluded.password_salt,
           password_key_length=excluded.password_key_length, password_cost=excluded.password_cost,
           password_block_size=excluded.password_block_size,
           password_parallelization=excluded.password_parallelization,
           failure_count=excluded.failure_count, lockout_until=excluded.lockout_until,
           updated_at=excluded.updated_at`
      )
      .run(
        ...credColumns(record.pin),
        ...credColumns(record.password),
        record.failureCount,
        Math.trunc(record.lockoutUntil),
        now,
        now
      )
  }
}
