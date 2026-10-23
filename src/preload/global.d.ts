import type { FlujoApi } from './index'

declare global {
  interface Window {
    flujo: FlujoApi
  }
}
