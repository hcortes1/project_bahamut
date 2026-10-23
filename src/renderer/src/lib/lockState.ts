import type { AuthStatusDto } from '@shared/ipc'

/**
 * Top-level app state. `epoch` changes on every lock/reset; the app tree is keyed by it, so
 * every screen unmounts and all renderer state is discarded.
 */
export type AppState =
  | { phase: 'loading'; epoch: number }
  | { phase: 'failed'; epoch: number }
  | { phase: 'setup'; epoch: number }
  | { phase: 'lock'; epoch: number; status: AuthStatusDto }
  | { phase: 'app'; epoch: number }

export type AppEvent =
  | { type: 'statusLoaded'; status: AuthStatusDto }
  | { type: 'statusFailed' }
  | { type: 'unlocked' }
  /** Session locked (idle, minimize, manual) or local data wiped: drop everything and re-read auth.status. */
  | { type: 'locked' }

export const initialState: AppState = { phase: 'loading', epoch: 0 }

export function appReducer(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case 'locked':
      return { phase: 'loading', epoch: state.epoch + 1 }
    case 'unlocked':
      return { phase: 'app', epoch: state.epoch }
    case 'statusFailed':
      return { phase: 'failed', epoch: state.epoch }
    case 'statusLoaded': {
      const { status } = event
      if (!status.configured) return { phase: 'setup', epoch: state.epoch }
      if (status.locked) return { phase: 'lock', epoch: state.epoch, status }
      return { phase: 'app', epoch: state.epoch }
    }
  }
}
