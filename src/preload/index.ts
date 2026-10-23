import { contextBridge, ipcRenderer } from 'electron'
import { CHANNEL_NAMES, EVENT_LOCKED, EVENT_PASSWORD_PROMPT } from '@shared/channel-names'
import type { FlujoApi } from '@shared/ipc'

// Narrow, typed API only, built from the same channel table main registers. Never expose ipcRenderer.
const groups: Record<string, Record<string, (req?: unknown) => Promise<unknown>>> = {}
for (const name of CHANNEL_NAMES) {
  const [group, method] = name.split('.') as [string, string]
  ;(groups[group] ??= {})[method] = (req?: unknown) => ipcRenderer.invoke(name, req)
}

const subscribe =
  <T>(channel: string) =>
  (cb: (e: T) => void): (() => void) => {
    const listener = (_event: unknown, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }

const api = {
  ...groups,
  appName: 'Flujo',
  on: { locked: subscribe(EVENT_LOCKED), passwordPrompt: subscribe(EVENT_PASSWORD_PROMPT) }
} as unknown as FlujoApi

contextBridge.exposeInMainWorld('flujo', api)
