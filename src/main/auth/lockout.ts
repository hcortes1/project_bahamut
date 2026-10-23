export const FREE_ATTEMPTS = 5
export const BASE_LOCKOUT_MS = 30_000
export const MAX_LOCKOUT_MS = 15 * 60_000

/**
 * Lockout duration after `failureCount` consecutive failures: none below 5,
 * 30s at 5, doubling per further failure, capped at 15 minutes.
 */
export function lockoutDurationMs(failureCount: number): number {
  if (failureCount < FREE_ATTEMPTS) return 0
  const exponent = Math.min(failureCount - FREE_ATTEMPTS, 30)
  return Math.min(BASE_LOCKOUT_MS * 2 ** exponent, MAX_LOCKOUT_MS)
}
