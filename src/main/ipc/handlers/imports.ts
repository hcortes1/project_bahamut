import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { EVENT_PASSWORD_PROMPT, type CommitResultDto, type PasswordPromptEvent, type ReviewViewDto } from '@shared/ipc'
import { categorizeWith, loadCategorizerContext } from '../../analysis/categorizer'
import { getAccount, listImports } from '../../db'
import {
  acknowledgeFileDuplicate,
  bulkSetCategory,
  commitImport,
  confirmCsvMapping,
  confirmRow,
  deleteRetainedFile,
  discardImport,
  editRow,
  getCommitBlockers,
  openImport,
  resolveDuplicate,
  resolveRemainingDuplicates,
  readRetainDefault,
  setCsvMapping,
  setExcluded,
  toReviewView,
  type ReviewSession
} from '../../ingest/pipeline'
import { MAX_OPEN_IMPORTS, type HandlerMap, type IpcContext } from '../context'
import { IpcFailure, notFound, orNotFound, toIpcError } from '../errors'

function sessionOf(ctx: IpcContext, id: string): ReviewSession {
  return orNotFound(ctx.imports.sessions.get(id))
}

const view = (s: ReviewSession): ReviewViewDto => toReviewView(s)

export const importsHandlers = {
  // The renderer never sees a retained file's directory.
  'imports.list': (ctx) => listImports(ctx.db).map((i) => ({ ...i, retainedFilePath: i.retainedFilePath ? basename(i.retainedFilePath) : null })),

  'imports.open': async (ctx, req) => {
    const store = ctx.imports
    if (store.sessions.size + store.pending >= MAX_OPEN_IMPORTS) {
      throw new IpcFailure('TOO_MANY_OPEN_IMPORTS', 'Finish or discard an open import first.')
    }
    store.pending++
    try {
      orNotFound(getAccount(ctx.db, req.accountId))
      const file = await ctx.pickImportFile()
      if (!file) return { cancelled: true as const }
      if (ctx.session.isLocked) throw new IpcFailure('LOCKED', 'The app is locked.')

      const categorizerCtx = loadCategorizerContext(ctx.db)
      const requestPassword: Parameters<typeof openImport>[1]['requestPassword'] = (attempt, reason) =>
        new Promise((resolve) => {
          const promptId = randomUUID()
          store.prompts.set(promptId, (pw) => {
            store.prompts.delete(promptId)
            resolve(pw)
          })
          const event: PasswordPromptEvent = { promptId, fileName: file.fileName, attempt, reason }
          ctx.emit(EVENT_PASSWORD_PROMPT, event)
        })

      let session: ReviewSession
      try {
        session = await openImport(ctx.db, {
          accountId: req.accountId,
          fileName: file.fileName,
          bytes: file.bytes,
          categorize: (row) => categorizeWith(categorizerCtx, row.description).categoryId,
          requestPassword
        })
      } catch (e) {
        const err = toIpcError(e)
        throw new IpcFailure(err.code, err.message, { fileName: err.fileName ?? file.fileName, ...(err.page !== undefined ? { page: err.page } : {}) })
      }
      // The app may have locked while the file was being parsed.
      if (ctx.session.isLocked) {
        discardImport(session)
        throw new IpcFailure('LOCKED', 'The app is locked.')
      }
      store.sessions.set(session.id, session)
      return { cancelled: false as const, review: view(session) }
    } finally {
      store.pending--
    }
  },

  'imports.view': (ctx, req) => view(sessionOf(ctx, req.sessionId)),

  'imports.setMapping': (ctx, req) => {
    const s = sessionOf(ctx, req.sessionId)
    // applyMappingOverrides defaults a missing confidence to 1; its declared type just requires it.
    setCsvMapping(ctx.db, s, req.mapping as Parameters<typeof setCsvMapping>[2])
    return view(s)
  },

  'imports.confirmMapping': (ctx, req) => {
    const s = sessionOf(ctx, req.sessionId)
    confirmCsvMapping(s)
    return view(s)
  },

  'imports.acknowledgeFileDuplicate': (ctx, req) => {
    const s = sessionOf(ctx, req.sessionId)
    acknowledgeFileDuplicate(s)
    return view(s)
  },

  'imports.editRow': (ctx, req) => {
    const s = sessionOf(ctx, req.sessionId)
    editRow(ctx.db, s, req.rowId, req.edit)
    return view(s)
  },

  'imports.setExcluded': (ctx, req) => {
    const s = sessionOf(ctx, req.sessionId)
    setExcluded(s, req.rowId, req.excluded)
    return view(s)
  },

  'imports.confirmRow': (ctx, req) => {
    const s = sessionOf(ctx, req.sessionId)
    confirmRow(s, req.rowId)
    return view(s)
  },

  'imports.bulkSetCategory': (ctx, req) => {
    const s = sessionOf(ctx, req.sessionId)
    bulkSetCategory(ctx.db, s, req.rowIds, req.categoryId)
    return view(s)
  },

  'imports.resolveDuplicate': (ctx, req) => {
    const s = sessionOf(ctx, req.sessionId)
    resolveDuplicate(s, req.groupId, req.decision)
    if (req.applyToAllRemaining) resolveRemainingDuplicates(s, req.decision)
    return view(s)
  },

  'imports.blockers': (ctx, req) => getCommitBlockers(sessionOf(ctx, req.sessionId)),

  'imports.commit': (ctx, req): CommitResultDto => {
    const s = sessionOf(ctx, req.sessionId)
    const keep = req.keepSourceFile ?? readRetainDefault(ctx.db)
    const r = commitImport(ctx.db, s, { keepSourceFile: keep, retainDir: ctx.retainDir })
    ctx.imports.sessions.delete(s.id)
    return { importId: r.importId, inserted: r.inserted, skippedDuplicates: r.skippedDuplicates, excluded: r.excluded, retained: r.retainedFilePath !== null }
  },

  'imports.discard': (ctx, req) => {
    const s = sessionOf(ctx, req.sessionId)
    discardImport(s)
    ctx.imports.sessions.delete(s.id)
    return null
  },

  'imports.providePassword': (ctx, req) => {
    const resolve = ctx.imports.prompts.get(req.promptId)
    if (!resolve) throw notFound()
    resolve(req.password)
    return null
  },

  'imports.deleteRetained': (ctx, req) => deleteRetainedFile(ctx.db, req.importId, req.alsoDeleteTransactions)
} satisfies Partial<HandlerMap>
