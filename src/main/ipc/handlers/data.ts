import { clearSensitiveState, type HandlerMap } from '../context'
import { failure } from './auth'

export const dataHandlers = {
  // Credentials are verified first (counting toward lockout); then data is wiped and the app locks.
  'data.wipe': async (ctx, req) => {
    const r = await ctx.auth.verify(req.current)
    if (!r.ok) {
      const f = failure(r)
      if (f.reason === 'locked' || f.reason === 'invalid') return { wiped: false, reason: f.reason, retryAfterMs: f.retryAfterMs }
      return { wiped: false, reason: f.reason }
    }
    await ctx.auth.forgotCredentials(() => ctx.resetDatabase())
    clearSensitiveState(ctx)
    ctx.session.lock('manual')
    return { wiped: true }
  }
} satisfies Partial<HandlerMap>
