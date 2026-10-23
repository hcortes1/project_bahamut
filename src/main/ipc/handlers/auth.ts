import type { ChangeResult, VerifyFailure } from '../../auth'
import { clearSensitiveState, type HandlerMap } from '../context'
import type { ChangeOutcome, VerifyOutcome } from '@shared/ipc'

export function failure(r: VerifyFailure): Extract<VerifyOutcome, { unlocked: false }> {
  if (r.reason === 'locked') return { unlocked: false, reason: 'locked', retryAfterMs: r.retryAfterMs }
  if (r.reason === 'invalid') return { unlocked: false, reason: 'invalid', failureCount: r.failureCount, retryAfterMs: r.retryAfterMs }
  return { unlocked: false, reason: r.reason }
}

function changeOutcome(r: ChangeResult): ChangeOutcome {
  if (r.ok) return { changed: true }
  return 'retryAfterMs' in r ? { changed: false, reason: r.reason, retryAfterMs: r.retryAfterMs } : { changed: false, reason: r.reason }
}

export const authHandlers = {
  'auth.status': (ctx) => ({ ...ctx.auth.status(), locked: ctx.session.isLocked }),

  // Setting credentials for the first time also unlocks, so the first-run flow can continue.
  'auth.setup': async (ctx, req) => {
    const r = await ctx.auth.setup(req)
    if (!r.ok) return { done: false, reason: r.reason }
    ctx.session.unlock()
    return { done: true }
  },

  'auth.verify': async (ctx, req) => {
    const r = await ctx.auth.verify(req)
    if (!r.ok) return failure(r)
    ctx.session.unlock()
    return { unlocked: true }
  },

  // "Forgot credentials": the only recovery is wiping local data.
  'auth.forgot': async (ctx) => {
    await ctx.auth.forgotCredentials(() => ctx.resetDatabase())
    clearSensitiveState(ctx)
    ctx.session.lock('manual')
    return null
  },

  'auth.lock': (ctx) => {
    ctx.session.lock('manual')
    return null
  },

  'auth.changeCredential': async (ctx, req) => changeOutcome(await ctx.auth.changeCredential(req.current, req.kind, req.next))
} satisfies Partial<HandlerMap>
