import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { unwrap } from './lib/api'
import { flujo } from './lib/flujo'
import { appReducer, initialState } from './lib/lockState'
import { SCREENS, type ScreenId } from './lib/screens'
import type { PasswordPromptEvent } from '@shared/ipc'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Icon } from './components/Icon'
import { PasswordPrompt } from './components/PasswordPrompt'
import { Accounts } from './screens/Accounts'
import { Lock } from './screens/Lock'
import { Budgets } from './screens/Budgets'
import { Goals } from './screens/Goals'
import { Dashboard } from './screens/Dashboard'
import { Import } from './screens/Import'
import { Optimizer } from './screens/Optimizer'
import { Settings } from './screens/Settings'
import { Transactions } from './screens/Transactions'
import { Setup } from './screens/Setup'

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState)
  const [startScreen, setStartScreen] = useState<ScreenId>('dashboard')

  // Any lock (idle, minimize, manual) discards all renderer state: the epoch changes and the tree below remounts.
  useEffect(() => flujo().on.locked(() => dispatch({ type: 'locked' })), [])

  useEffect(() => {
    if (state.phase !== 'loading') return
    let live = true
    unwrap(flujo().auth.status()).then(
      (status) => live && dispatch({ type: 'statusLoaded', status }),
      () => live && dispatch({ type: 'statusFailed' })
    )
    return () => {
      live = false
    }
  }, [state.phase, state.epoch])

  const reset = useCallback(() => dispatch({ type: 'locked' }), [])

  switch (state.phase) {
    case 'loading':
      return (
        <main className="center-screen">
          <p role="status">Loading Flujo&hellip;</p>
        </main>
      )
    case 'failed':
      return (
        <main className="center-screen">
          <div className="card lock-card stack" role="alert">
            <h1>Flujo could not start</h1>
            <p>Flujo could not read its status. Close and reopen the app.</p>
            <button type="button" className="btn primary" onClick={reset}>
              Try again
            </button>
          </div>
        </main>
      )
    case 'setup':
      return (
        <Setup
          key={state.epoch}
          onFinish={(go) => {
            setStartScreen(go)
            dispatch({ type: 'unlocked' })
          }}
        />
      )
    case 'lock':
      return (
        <Lock
          key={state.epoch}
          status={state.status}
          onUnlocked={() => {
            setStartScreen('dashboard')
            dispatch({ type: 'unlocked' })
          }}
          onWiped={reset}
        />
      )
    case 'app':
      return <Shell key={state.epoch} initial={startScreen} onLocked={reset} />
  }
}

function Shell({ initial, onLocked }: { initial: ScreenId; onLocked: () => void }) {
  const [screen, setScreen] = useState<ScreenId>(initial)
  const [prompt, setPrompt] = useState<PasswordPromptEvent | null>(null)
  const main = useRef<HTMLElement>(null)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) first.current = false
    else main.current?.focus()
  }, [screen])

  useEffect(() => flujo().on.passwordPrompt(setPrompt), [])

  const lockNow = () => {
    void flujo().auth.lock()
    onLocked()
  }

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <Icon name="budgets" />
          </span>
          <div>
            <div className="brand-name">Flujo</div>
            <div className="brand-sub">Personal</div>
          </div>
        </div>
        <ul>
          {SCREENS.map((s) => (
            <li key={s.id}>
              <button type="button" className="nav-item" aria-current={s.id === screen ? 'page' : undefined} onClick={() => setScreen(s.id)}>
                <Icon name={s.icon} />
                {s.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="rail-foot">
          <button type="button" className="nav-item" onClick={lockNow}>
            <Icon name="lock" />
            Lock
          </button>
        </div>
      </nav>
      <main className="content" tabIndex={-1} ref={main}>
        <ErrorBoundary key={screen}>
        {screen === 'accounts' && <Accounts />}
        {screen === 'transactions' && <Transactions />}
        {screen === 'budgets' && <Budgets />}
        {screen === 'goals' && <Goals />}
        {screen === 'dashboard' && <Dashboard />}
        {screen === 'optimizer' && <Optimizer />}
        {screen === 'import' && <Import />}
        {screen === 'settings' && <Settings onWiped={onLocked} />}
        </ErrorBoundary>
      </main>
      {prompt && <PasswordPrompt key={prompt.promptId} prompt={prompt} onDone={() => setPrompt(null)} />}
    </div>
  )
}
