import { useState, type FormEvent } from 'react'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { AccountForm } from '../components/AccountForm'
import { Icon } from '../components/Icon'
import { ErrorText } from '../components/ui'
import type { ScreenId } from '../lib/screens'

const STEPS = ['Credentials', 'First account', 'Statement import'] as const

export function Setup({ onFinish }: { onFinish: (go: ScreenId) => void }) {
  const [step, setStep] = useState(0)
  return (
    <main className="center-screen">
      <div className="card wizard">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <Icon name="lock" />
          </span>
          <h1>Set up Flujo</h1>
        </div>
        <ol className="stepper" aria-label="Setup progress">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : i === step ? 'current' : ''}>
              <span className="step-dot">{i < step ? <Icon name="check" size={14} /> : i + 1}</span>
              <span>{s}</span>
              {i < step && <span className="sr-only"> (done)</span>}
            </li>
          ))}
        </ol>
        {step === 0 && <CredentialsStep onDone={() => setStep(1)} />}
        {step === 1 && (
          <section className="stack" aria-labelledby="s2">
            <h2 id="s2">Add your first account</h2>
            <AccountForm
              submitLabel="Add account"
              onSubmit={async (v) => {
                await unwrap(flujo().accounts.create(v))
                setStep(2)
              }}
            />
          </section>
        )}
        {step === 2 && (
          <section className="stack" aria-labelledby="s3">
            <h2 id="s3">Import a statement</h2>
            <p>Bring in a Bank of America PDF statement or a CSV file to fill your dashboard. You can also do this later from the Import screen.</p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => onFinish('dashboard')}>
                Finish without importing
              </button>
              <button type="button" className="btn primary" onClick={() => onFinish('import')}>
                Go to Import
              </button>
            </div>
          </section>
        )}
        <p className="notice info">
          <Icon name="info" />
          <span>
            Flujo is 100% offline. If you forget your credentials, the only way back in is to wipe local data. Flujo cannot recover them for you. The lock
            keeps others out of the app; it does not encrypt your data.
          </span>
        </p>
      </div>
    </main>
  )
}

const SETUP_REASONS = {
  already_configured: 'Flujo is already set up. Restart the app.',
  no_credential: 'Set a PIN, a password, or both.',
  invalid_format: 'Check the PIN (4 to 8 digits) and password (at least 8 characters).'
} as const

function CredentialsStep({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (pin === '' && pw === '') return setError(SETUP_REASONS.no_credential)
    if (pin !== '' && !/^\d{4,8}$/.test(pin)) return setError('The PIN must be 4 to 8 digits.')
    if (pin !== pin2) return setError('The two PINs do not match.')
    if (pw !== '' && pw.length < 8) return setError('The password must be at least 8 characters.')
    if (pw !== pw2) return setError('The two passwords do not match.')
    setBusy(true)
    setError(null)
    try {
      const out = await unwrap(flujo().auth.setup({ ...(pin ? { pin } : {}), ...(pw ? { password: pw } : {}) }))
      if (out.done) return onDone()
      setError(SETUP_REASONS[out.reason])
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPin('')
      setPin2('')
      setPw('')
      setPw2('')
    }
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="stack" aria-labelledby="s1">
      <h2 id="s1">Choose how to unlock Flujo</h2>
      <p className="muted">Set a PIN, a password, or both. If you set both, you need both to unlock.</p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pin">PIN (4 to 8 digits)</label>
          <input id="pin" type="password" inputMode="numeric" maxLength={8} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="pin2">Confirm PIN</label>
          <input id="pin2" type="password" inputMode="numeric" maxLength={8} autoComplete="off" value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="field">
          <label htmlFor="pw">Password (at least 8 characters)</label>
          <input id="pw" type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pw2">Confirm password</label>
          <input id="pw2" type="password" autoComplete="off" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </div>
      </div>
      <ErrorText message={error} />
      <div className="actions">
        <button type="submit" className="btn primary" disabled={busy}>
          Continue
        </button>
      </div>
    </form>
  )
}
