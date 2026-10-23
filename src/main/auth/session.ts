export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000
export const MIN_IDLE_TIMEOUT_MS = 30_000
export const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60_000

function checkTimeout(ms: number): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < MIN_IDLE_TIMEOUT_MS || ms > MAX_IDLE_TIMEOUT_MS) {
    throw new RangeError(`idleTimeoutMs must be a finite number between ${MIN_IDLE_TIMEOUT_MS} and ${MAX_IDLE_TIMEOUT_MS}`)
  }
  return ms
}

export type LockReason = 'idle' | 'minimize' | 'manual'

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface SessionOptions {
  idleTimeoutMs?: number
  lockOnMinimize?: boolean
  timers?: TimerApi
}

const realTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** Idle auto-lock. Starts locked; call unlock() after a successful verify. */
export class SessionManager {
  private locked = true
  private handle: unknown = null
  private idleTimeoutMs: number
  private lockOnMinimize: boolean
  private readonly timers: TimerApi
  private readonly listeners = new Set<(reason: LockReason) => void>()

  constructor(options: SessionOptions = {}) {
    this.idleTimeoutMs = checkTimeout(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)
    this.lockOnMinimize = options.lockOnMinimize ?? false
    this.timers = options.timers ?? realTimers
  }

  get isLocked(): boolean {
    return this.locked
  }

  /** Subscribe to lock events (caller clears renderer state). Returns unsubscribe. */
  onLock(listener: (reason: LockReason) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  unlock(): void {
    this.locked = false
    this.arm()
  }

  lock(reason: LockReason = 'manual'): void {
    this.disarm()
    if (this.locked) return
    this.locked = true
    for (const l of [...this.listeners]) {
      try {
        l(reason)
      } catch {
        // A failing listener must not stop the others from clearing sensitive state.
      }
    }
  }

  /** Call on user input while unlocked to restart the idle countdown. */
  activity(): void {
    if (!this.locked) this.arm()
  }

  notifyMinimize(): void {
    if (this.lockOnMinimize) this.lock('minimize')
  }

  configure(opts: { idleTimeoutMs?: number; lockOnMinimize?: boolean }): void {
    // Validate everything before applying anything.
    const timeout = opts.idleTimeoutMs !== undefined ? checkTimeout(opts.idleTimeoutMs) : undefined
    if (opts.lockOnMinimize !== undefined && typeof opts.lockOnMinimize !== 'boolean') {
      throw new TypeError('lockOnMinimize must be a boolean')
    }
    if (timeout !== undefined) this.idleTimeoutMs = timeout
    if (opts.lockOnMinimize !== undefined) this.lockOnMinimize = opts.lockOnMinimize
    if (!this.locked) this.arm()
  }

  dispose(): void {
    this.disarm()
    this.listeners.clear()
  }

  private arm(): void {
    this.disarm()
    this.handle = this.timers.setTimeout(() => this.lock('idle'), this.idleTimeoutMs)
  }

  private disarm(): void {
    if (this.handle !== null) {
      this.timers.clearTimeout(this.handle)
      this.handle = null
    }
  }
}
