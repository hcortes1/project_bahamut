import type { z } from 'zod'
import type { channels, ChannelName, ChannelResponse } from '@shared/ipc'
import type { AuthManager, SessionManager } from '../auth'
import type { Db } from '../db'
import type { ReviewSession } from '../ingest/pipeline'
import type { OptimizerInput, OptimizerResult } from '../analysis/optimizer'

export const MAX_OPEN_IMPORTS = 5

/** Open review sessions and pending password prompts. In memory only; discarded on lock. */
export class ImportStore {
  readonly sessions = new Map<string, ReviewSession>()
  readonly prompts = new Map<string, (password: string | null) => void>()
  /** imports.open calls past the limit check but without a session yet, so parallel calls cannot exceed the limit. */
  pending = 0

  /** Discard every session (dropping file bytes) and cancel every pending password prompt. */
  clear(): void {
    for (const s of this.sessions.values()) {
      s.bytes = new Uint8Array(0)
      s.rows = []
      s.status = 'discarded'
    }
    this.sessions.clear()
    for (const resolve of this.prompts.values()) resolve(null)
    this.prompts.clear()
  }
}

export interface PickedFile {
  /** Base name only. */
  fileName: string
  bytes: Uint8Array
}

/** Everything handlers need. Electron-free so handlers can be unit-tested. */
export interface IpcContext {
  /** Current database handle (replaced by resetDatabase). */
  readonly db: Db
  readonly auth: AuthManager
  readonly session: SessionManager
  readonly imports: ImportStore
  /** Last optimizer result, kept in main so suggested budget amounts never come from the renderer. */
  lastOptimizer: OptimizerResult | null
  /** Directory where kept source files are copied. */
  readonly retainDir: string
  runOptimizer(input: OptimizerInput): Promise<OptimizerResult>
  /** Open dialog + read in main. null = cancelled. */
  pickImportFile(): Promise<PickedFile | null>
  /** Save dialog in main. null = cancelled. The path never reaches the renderer. */
  chooseSavePath(defaultName: string): Promise<string | null>
  writeTextFile(path: string, content: string): Promise<void>
  /** Close the DB, delete its files and retained imports, open a fresh migrated DB. */
  resetDatabase(): void | Promise<void>
  /** Local calendar date, YYYY-MM-DD. */
  today(): string
  /** The app window's webContents (compared by identity with the IPC sender) and its main frame, or null. */
  getWebContents(): { mainFrame: unknown } | null
  /** Is this frame URL the app's own page? */
  isAppUrl(url: string): boolean
  /** Send an event to the renderer. */
  emit(channel: string, payload: unknown): void
}

/** Lock side effects: drop import sessions, cancel password prompts, forget optimizer results. */
export function clearSensitiveState(ctx: IpcContext): void {
  ctx.imports.clear()
  ctx.lastOptimizer = null
}

export type Req<K extends ChannelName> = z.output<(typeof channels)[K]['request']>
export type Handler<K extends ChannelName> = (ctx: IpcContext, req: Req<K>) => ChannelResponse<K> | Promise<ChannelResponse<K>>
export type HandlerMap = { [K in ChannelName]: Handler<K> }
