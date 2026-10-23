import type { FlujoApi } from '@shared/ipc'

declare global {
  interface Window {
    flujo: FlujoApi
  }
}
