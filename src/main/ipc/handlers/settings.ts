import type { SettingsDto } from '@shared/ipc'
import { DEFAULT_IDLE_TIMEOUT_MS } from '../../auth'
import type { Db } from '../../db'
import { getSetting, setSetting } from '../../db'
import { readRetainDefault, readThreshold } from '../../ingest/pipeline'
import type { HandlerMap } from '../context'

const IDLE_KEY = 'idle_timeout_ms'
const MINIMIZE_KEY = 'lock_on_minimize'

export function readSettings(db: Db): SettingsDto {
  const idle = Number(getSetting(db, IDLE_KEY))
  return {
    idleTimeoutMs: Number.isFinite(idle) && idle > 0 ? idle : DEFAULT_IDLE_TIMEOUT_MS,
    lockOnMinimize: getSetting(db, MINIMIZE_KEY) === 'true',
    retainImports: readRetainDefault(db),
    importConfidenceThreshold: readThreshold(db)
  }
}

export const settingsHandlers = {
  'settings.get': (ctx) => readSettings(ctx.db),

  'settings.update': (ctx, req) => {
    const db = ctx.db
    db.transaction(() => {
      if (req.idleTimeoutMs !== undefined) setSetting(db, IDLE_KEY, String(req.idleTimeoutMs))
      if (req.lockOnMinimize !== undefined) setSetting(db, MINIMIZE_KEY, String(req.lockOnMinimize))
      if (req.retainImports !== undefined) setSetting(db, 'retain_imports', String(req.retainImports))
      if (req.importConfidenceThreshold !== undefined) {
        setSetting(db, 'import_confidence_threshold', String(req.importConfidenceThreshold))
      }
    })()
    ctx.session.configure({ idleTimeoutMs: req.idleTimeoutMs, lockOnMinimize: req.lockOnMinimize })
    return readSettings(db)
  }
} satisfies Partial<HandlerMap>
