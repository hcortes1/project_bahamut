import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { PickedFile } from './context'
import { IpcFailure } from './errors'

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024

/** Read a user-picked file in main. Fixed errors only; the size is re-checked after the read. */
export async function readImportFile(path: string, maxBytes = MAX_IMPORT_BYTES): Promise<PickedFile> {
  const fileName = basename(path)
  const tooLarge = (): IpcFailure => new IpcFailure('FILE_TOO_LARGE', 'The file is too large to import.', { fileName })
  let bytes: Buffer
  try {
    if ((await stat(path)).size > maxBytes) throw tooLarge()
    bytes = await readFile(path)
  } catch (e) {
    if (e instanceof IpcFailure) throw e
    throw new IpcFailure('FILE_UNREADABLE', 'The file could not be read.', { fileName })
  }
  if (bytes.length > maxBytes) throw tooLarge()
  return { fileName, bytes: new Uint8Array(bytes) }
}
