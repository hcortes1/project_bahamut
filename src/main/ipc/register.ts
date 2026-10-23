import { channels, EVENT_LOCKED, type ChannelName, type LockedEvent, type Result } from '@shared/ipc'
import { clearSensitiveState, type HandlerMap, type IpcContext } from './context'
import { IpcFailure, toIpcError } from './errors'
import { handlers as defaultHandlers } from './handlers'

/** The slice of Electron's ipcMain / IpcMainInvokeEvent that registration needs. */
export interface IpcEventLike {
  sender: unknown
  senderFrame: { url: string } | null
}
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, payload?: unknown) => Promise<Result<unknown>>): void
}

function checkSender(ctx: IpcContext, event: IpcEventLike): void {
  const wc = ctx.getWebContents()
  const frame = event.senderFrame
  if (wc === null || event.sender !== wc || !frame || frame !== wc.mainFrame || !ctx.isAppUrl(frame.url)) {
    throw new IpcFailure('FORBIDDEN_SENDER', 'Request not allowed.')
  }
}

/**
 * Registers every channel. Per call, in this order: sender validation, LOCKED gate (non-public
 * channels), zod parse, handler. Idle-timer activity comes from real window input (see index.ts), never
 * from IPC traffic. Returns a function that detaches the lock listener.
 */
export function registerIpc(ipcMain: IpcMainLike, ctx: IpcContext, handlers: HandlerMap = defaultHandlers): () => void {
  for (const name of Object.keys(channels) as ChannelName[]) {
    const def = channels[name]
    ipcMain.handle(name, async (event, payload): Promise<Result<unknown>> => {
      try {
        checkSender(ctx, event)
        if (!def.public && ctx.session.isLocked) throw new IpcFailure('LOCKED', 'The app is locked.')
        const parsed = def.request.safeParse(payload)
        if (!parsed.success) throw new IpcFailure('INVALID_PAYLOAD', 'Invalid request.')
        const handler = handlers[name] as (c: IpcContext, r: unknown) => unknown
        return { ok: true, data: await handler(ctx, parsed.data) }
      } catch (e) {
        const error = toIpcError(e)
        // Codes only: never the error message, which could carry data.
        if (error.code === 'INTERNAL') console.error(`ipc ${name}: INTERNAL (${e instanceof Error ? e.name : typeof e})`)
        return { ok: false, error }
      }
    })
  }
  return ctx.session.onLock((reason) => {
    clearSensitiveState(ctx)
    const event: LockedEvent = { reason }
    ctx.emit(EVENT_LOCKED, event)
  })
}
