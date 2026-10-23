import {
  DEFAULT_SCRYPT_PARAMS,
  hashCredential,
  passwordSchema,
  pinSchema,
  verifyCredential,
  type ScryptParams
} from './credentials'
import { lockoutDurationMs, MAX_LOCKOUT_MS } from './lockout'
import type { AuthRecord, AuthStore, StoredCredential } from './store'

export type CredentialKind = 'pin' | 'password'

export interface CredentialInput {
  pin?: string
  password?: string
}

export type VerifyFailure =
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'invalid_input' }
  | { ok: false; reason: 'locked'; retryAfterMs: number }
  | { ok: false; reason: 'invalid'; failureCount: number; retryAfterMs: number }

export type VerifyResult = { ok: true } | VerifyFailure

export type SetupResult =
  | { ok: true }
  | { ok: false; reason: 'already_configured' | 'no_credential' | 'invalid_format' }

export type ChangeResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_format' | 'would_remove_last_credential' | 'not_enabled' }
  | VerifyFailure

export interface AuthStatus {
  configured: boolean
  pinEnabled: boolean
  passwordEnabled: boolean
  /** Epoch ms of lockout end, or 0 when not locked out. */
  lockedOutUntil: number
}

export interface AuthManagerOptions {
  store: AuthStore
  /** Epoch ms clock; injectable for tests. */
  now?: () => number
  scryptParams?: ScryptParams
}

/** Longest secret accepted by verify(); anything else is rejected before any key derivation. */
export const MAX_SECRET_LENGTH = 1024

function validShape(input: unknown): input is CredentialInput {
  if (typeof input !== 'object' || input === null) return false
  for (const k of ['pin', 'password'] as const) {
    const v = (input as Record<string, unknown>)[k]
    if (v !== undefined && (typeof v !== 'string' || v.length > MAX_SECRET_LENGTH)) return false
  }
  return true
}

const clampRemaining = (ms: number): number => Math.min(ms, MAX_LOCKOUT_MS)

function validFormat(input: CredentialInput): boolean {
  if (input.pin !== undefined && !pinSchema.safeParse(input.pin).success) return false
  if (input.password !== undefined && !passwordSchema.safeParse(input.password).success) {
    return false
  }
  return true
}

export class AuthManager {
  private readonly store: AuthStore
  private readonly now: () => number
  private readonly params: ScryptParams
  /** Promise-chain mutex: every state-changing operation runs strictly one at a time. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: AuthManagerOptions) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.params = options.scryptParams ?? DEFAULT_SCRYPT_PARAMS
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  status(): AuthStatus {
    const r = this.store.get()
    const remaining = r ? clampRemaining(r.lockoutUntil - this.now()) : 0
    return {
      configured: r !== null,
      pinEnabled: !!r?.pin,
      passwordEnabled: !!r?.password,
      lockedOutUntil: remaining > 0 ? this.now() + remaining : 0
    }
  }

  /** First-time setup. At least one of pin/password is required. */
  setup(input: CredentialInput): Promise<SetupResult> {
    return this.serialize(async () => {
      if (this.store.get()) return { ok: false, reason: 'already_configured' } as const
      if (!validShape(input)) return { ok: false, reason: 'invalid_format' } as const
      if (input.pin === undefined && input.password === undefined) {
        return { ok: false, reason: 'no_credential' } as const
      }
      if (!validFormat(input)) return { ok: false, reason: 'invalid_format' } as const
      this.store.set({
        pin: input.pin !== undefined ? await hashCredential(input.pin, this.params) : null,
        password:
          input.password !== undefined ? await hashCredential(input.password, this.params) : null,
        failureCount: 0,
        lockoutUntil: 0
      })
      return { ok: true } as const
    })
  }

  /**
   * Unlock check. Every enabled credential must be supplied and correct. Calls are serialized, and
   * the incremented failure count (and any lockout it triggers) is persisted BEFORE the slow key
   * derivation, so concurrent or interrupted attempts can never be free; success resets it.
   * Attempts made during lockout are rejected without being evaluated or counted.
   */
  verify(input: CredentialInput): Promise<VerifyResult> {
    if (!validShape(input)) return Promise.resolve({ ok: false, reason: 'invalid_input' })
    return this.serialize(() => this.verifyLocked(input))
  }

  private async verifyLocked(input: CredentialInput): Promise<VerifyResult> {
    const record = this.store.get()
    if (!record) return { ok: false, reason: 'not_configured' }
    const remaining = clampRemaining(record.lockoutUntil - this.now())
    if (remaining > 0) return { ok: false, reason: 'locked', retryAfterMs: remaining }

    const failureCount = record.failureCount + 1
    const delay = lockoutDurationMs(failureCount)
    this.write(record, failureCount, delay > 0 ? this.now() + delay : 0)

    const pairs: Array<[string | undefined, StoredCredential | null]> = [
      [input.pin, record.pin],
      [input.password, record.password]
    ]
    const checks: Array<Promise<boolean>> = []
    for (const [secret, stored] of pairs) {
      if (!stored) continue
      // A missing secret still burns a derivation so timing does not reveal it.
      checks.push(
        verifyCredential(secret ?? '', stored).then((matched) => matched && secret !== undefined)
      )
    }
    const ok = (await Promise.all(checks)).every(Boolean)

    if (ok) {
      this.write(record, 0, 0)
      return { ok: true }
    }
    return { ok: false, reason: 'invalid', failureCount, retryAfterMs: delay }
  }

  /**
   * Sets (string) or removes (null) one credential. The current credential(s) are verified FIRST
   * (counting toward lockout); only then are the request's validity and policy checked. Removing the
   * last remaining credential is refused.
   */
  changeCredential(
    current: CredentialInput,
    kind: CredentialKind,
    next: string | null
  ): Promise<ChangeResult> {
    if (!validShape(current)) return Promise.resolve({ ok: false, reason: 'invalid_input' })
    return this.serialize(async (): Promise<ChangeResult> => {
      const check = await this.verifyLocked(current)
      if (!check.ok) return check
      const record = this.store.get()
      if (!record) return { ok: false, reason: 'not_configured' }
      if (kind !== 'pin' && kind !== 'password') return { ok: false, reason: 'invalid_format' }
      if (next !== null && !(kind === 'pin' ? pinSchema : passwordSchema).safeParse(next).success) {
        return { ok: false, reason: 'invalid_format' }
      }
      if (next === null) {
        if (!record[kind]) return { ok: false, reason: 'not_enabled' }
        const other = kind === 'pin' ? record.password : record.pin
        if (!other) return { ok: false, reason: 'would_remove_last_credential' }
      }
      const value = next === null ? null : await hashCredential(next, this.params)
      this.store.set({ ...record, [kind]: value })
      return { ok: true }
    })
  }

  /**
   * "Forgot credentials": the only recovery is wiping local data. Auth state is cleared FIRST (while
   * the database is still open), then the injected wipe runs. If the wipe fails, the previous auth
   * record is restored (best effort) and the error rethrown, so a failed wipe never leaves data
   * behind without a lock. There is no other way in.
   */
  forgotCredentials(wipe: () => void | Promise<void>): Promise<void> {
    return this.serialize(async () => {
      const previous = this.store.get()
      this.store.set(null)
      try {
        await wipe()
      } catch (e) {
        try {
          this.store.set(previous)
        } catch {
          /* database unavailable; nothing more we can do */
        }
        throw e
      }
    })
  }

  private write(record: AuthRecord, failureCount: number, lockoutUntil: number): void {
    this.store.set({ ...record, failureCount, lockoutUntil })
  }
}
