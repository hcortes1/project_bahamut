import type { FlujoApi } from '@shared/ipc'

/** The only door to the main process. Every call resolves to Result<T>; wrap with `unwrap`. */
export const flujo = (): FlujoApi => window.flujo
