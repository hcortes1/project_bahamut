import { contextBridge } from 'electron'

// Narrow, typed API only. Never expose ipcRenderer directly.
const api = {
  appName: 'Flujo'
} as const

contextBridge.exposeInMainWorld('flujo', api)

export type FlujoApi = typeof api
