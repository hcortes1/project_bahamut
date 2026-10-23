import { PdfIngestError } from './errors'
import { defaultPdfRunner, type PdfParseRunner } from './runner'
import type { PdfAssets } from './extract'
import { parseStatementPdf } from './parse'
import type { ParsedStatement } from './types'

export * from './errors'
export * from './types'
export { extractDocument } from './extract'
export { bofaParser } from './bofa'
export { STATEMENT_PARSERS, parseDocument, parseStatementPdf, type ParseOptions } from './parse'
export {
  createWorkerRunner,
  defaultPdfRunner,
  findPdfWorkerPath,
  inProcessRunner,
  type PdfParseJob,
  type PdfParseRunner
} from './runner'

export interface PasswordPromptOptions {
  fileName: string
  /** Called when a password is needed; resolve null/undefined if the user cancels. */
  requestPassword: (attempt: number, reason: 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT') => Promise<string | null | undefined>
  /** Maximum number of passwords the user may try (default 3). */
  maxAttempts?: number
  /** How a single parse runs. Default: a fresh worker thread per attempt (in-process under vitest only). */
  runner?: PdfParseRunner
  /** Only honoured by the in-process path; the worker resolves its own assets. */
  assets?: PdfAssets
}

/**
 * Main-side prompt/retry loop. Every attempt is a separate parse (a separate worker thread in the app),
 * so the password lives only in a local variable and in the one worker that is terminated right after.
 * It is never persisted, logged, or placed in an error.
 */
export async function parseStatementPdfWithPasswordPrompt(bytes: Uint8Array, opts: PasswordPromptOptions): Promise<ParsedStatement> {
  const max = opts.maxAttempts ?? 3
  const run: PdfParseRunner =
    opts.runner ??
    (opts.assets
      ? (job) => parseStatementPdf(job.bytes, { fileName: job.fileName, password: job.password, assets: opts.assets })
      : defaultPdfRunner())
  let password: string | undefined
  let prompts = 0
  for (;;) {
    try {
      return await run({ bytes, fileName: opts.fileName, password })
    } catch (e) {
      if (!(e instanceof PdfIngestError) || (e.code !== 'PASSWORD_REQUIRED' && e.code !== 'PASSWORD_INCORRECT')) throw e
      if (prompts >= max) {
        throw new PdfIngestError('PASSWORD_RETRIES_EXHAUSTED', opts.fileName, 'Too many incorrect passwords.')
      }
      prompts++
      const next = await opts.requestPassword(prompts, e.code)
      if (!next) {
        throw new PdfIngestError('PASSWORD_REQUIRED', opts.fileName, 'The PDF is password protected and no password was provided.')
      }
      password = next
    }
  }
}
