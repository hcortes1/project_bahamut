/** Scrypt-hashed credential. Only hash, salt and parameters are ever stored. */
export interface StoredCredential {
  readonly algorithm: 'scrypt'
  /** base64 */
  readonly salt: string
  /** base64 */
  readonly hash: string
  readonly keyLength: number
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
}

export interface AuthRecord {
  readonly pin: StoredCredential | null
  readonly password: StoredCredential | null
  /** Consecutive failed unlock attempts since the last success. */
  readonly failureCount: number
  /** Epoch ms until which attempts are rejected; 0 when not locked out. */
  readonly lockoutUntil: number
}

/**
 * Persistence boundary for auth state. The DB layer implements this later.
 * Synchronous to match better-sqlite3.
 */
export interface AuthStore {
  /** Returns the record, or null when no credential has been configured. */
  get(): AuthRecord | null
  /** Replaces the record; null clears all auth state. */
  set(record: AuthRecord | null): void
}

export class InMemoryAuthStore implements AuthStore {
  private record: AuthRecord | null = null

  get(): AuthRecord | null {
    return this.record ? { ...this.record } : null
  }

  set(record: AuthRecord | null): void {
    this.record = record ? { ...record } : null
  }
}
