import { useEffect, useState, type FormEvent } from 'react'
import type { AuthStatusDto } from '@shared/ipc'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { formatCountdown } from '../lib/format'
import { CredentialInputs, credentialsFilled, emptyCredentials, toCredentials, type CredentialValues } from '../components/Credentials'
import { Icon } from '../components/Icon'
import { ConfirmDialog, ErrorText, WipeList } from '../components/ui'

export function Lock({ status, onUnlocked, onWiped }: { status: AuthStatusDto; onUnlocked: () => void; onWiped: () => void }) {
  const { pinEnabled, passwordEnabled } = status
  const [creds, setCreds] = useState<CredentialValues>(emptyCredentials)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [until, setUntil] = useState(status.lockedOutUntil)
  const [span, setSpan] = useState(Math.max(0, status.lockedOutUntil - Date.now()))
  const [now, setNow] = useState(Date.now())
  const [confirmWipe, setConfirmWipe] = useState(false)

  const remaining = Math.max(0, until - now)
  const lockedOut = remaining > 0

  useEffect(() => {
    if (!lockedOut) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [lockedOut])

  const startLockout = (ms: number) => {
    const t = Date.now()
    setNow(t)
    setUntil(t + ms)
    setSpan(ms)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || lockedOut || !credentialsFilled(creds, pinEnabled, passwordEnabled)) return
    setBusy(true)
    setError(null)
    try {
      const out = await unwrap(flujo().auth.verify(toCredentials(creds, pinEnabled, passwordEnabled)))
      if (out.unlocked) return onUnlocked()
      if (out.reason === 'locked') {
        startLockout(out.retryAfterMs)
        setError(null)
      } else if (out.reason === 'invalid') {
        if (out.retryAfterMs > 0) startLockout(out.retryAfterMs)
        setError(`Incorrect credentials. Failed attempts: ${out.failureCount}.`)
      } else {
        setError('Enter your credentials in the format they were created with.')
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setCreds(emptyCredentials)
    }
    setBusy(false)
  }

  return (
    <main className="center-screen">
      <div className="card lock-card">
        <div className="brand lock-brand">
          <span className="logo" aria-hidden="true">
            <Icon name="lock" />
          </span>
          <h1>Flujo</h1>
        </div>
        <p className="muted">Enter your {pinEnabled && passwordEnabled ? 'PIN and password' : pinEnabled ? 'PIN' : 'password'} to open Flujo.</p>

        {lockedOut && (
          <div className="notice warn" role="status">
            <Icon name="alert" />
            <div>
              <strong>Too many failed attempts.</strong> Try again in <span className="num">{formatCountdown(remaining)}</span>.
              <progress value={span - remaining} max={span} aria-label="Time until you can try again" />
            </div>
          </div>
        )}

        <form onSubmit={submit} className="stack">
          <CredentialInputs
            value={creds}
            onChange={setCreds}
            pinEnabled={pinEnabled}
            passwordEnabled={passwordEnabled}
            disabled={lockedOut || busy}
            autoFocus
          />
          <ErrorText message={error} />
          <button type="submit" className="btn primary" disabled={lockedOut || busy || !credentialsFilled(creds, pinEnabled, passwordEnabled)}>
            Unlock
          </button>
        </form>

        <details className="forgot">
          <summary>Forgot credentials?</summary>
          <p>Flujo is 100% offline. Forgotten credentials can only be recovered by wiping local data.</p>
          <button type="button" className="btn danger" onClick={() => setConfirmWipe(true)}>
            <Icon name="trash" size={16} /> Wipe all local data
          </button>
        </details>
      </div>

      {confirmWipe && (
        <ConfirmDialog
          title="Wipe all local data?"
          confirmLabel="Wipe all local data"
          typeToConfirm="WIPE"
          onClose={() => setConfirmWipe(false)}
          onConfirm={async () => {
            await unwrap(flujo().auth.forgot({ confirmWipe: true }))
            onWiped()
          }}
        >
          <p>This permanently deletes:</p>
          <WipeList />
          <p>You will set up Flujo again from scratch. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </main>
  )
}
