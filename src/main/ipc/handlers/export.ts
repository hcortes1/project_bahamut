import { exportSummaryCsv, exportTransactionsCsv } from '../../features'
import type { HandlerMap } from '../context'
import { IpcFailure } from '../errors'

export const exportHandlers = {
  'export.csv': async (ctx, req) => {
    const path = await ctx.chooseSavePath(`flujo-${req.kind}-${req.range.from}_${req.range.to}.csv`)
    if (!path) return { saved: false }
    // The app may have locked while the dialog was open: write nothing.
    if (ctx.session.isLocked) throw new IpcFailure('LOCKED', 'The app is locked.')
    const content = req.kind === 'transactions' ? exportTransactionsCsv(ctx.db, req.range) : exportSummaryCsv(ctx.db, req.range)
    await ctx.writeTextFile(path, content)
    return { saved: true }
  }
} satisfies Partial<HandlerMap>
