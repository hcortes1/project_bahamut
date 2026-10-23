import { useId, useState, type FormEvent } from 'react'
import type { Account } from '@shared/db-types'
import { ACCOUNT_TYPES } from '../lib/accountTypes'
import { errorMessage } from '../lib/api'
import { ErrorText } from './ui'

export interface AccountValues {
  name: string
  type: Account['type']
  institution: string | null
  last4: string | null
}

/** Account fields shared by the setup wizard and the Accounts screen. */
export function AccountForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel
}: {
  initial?: Account
  submitLabel: string
  onSubmit: (v: AccountValues) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<Account['type']>(initial?.type ?? 'checking')
  const [institution, setInstitution] = useState(initial?.institution ?? '')
  const [last4, setLast4] = useState(initial?.last4 ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ids = { name: useId(), type: useId(), inst: useId(), last4: useId(), hint: useId() }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() === '') return setError('Enter an account name.')
    if (last4 !== '' && !/^\d{4}$/.test(last4)) return setError('Last 4 digits must be exactly 4 digits, or left blank.')
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ name: name.trim(), type, institution: institution.trim() || null, last4: last4 || null })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="stack">
      <div className="field">
        <label htmlFor={ids.name}>Account name</label>
        <input id={ids.name} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor={ids.type}>Type</label>
        <select id={ids.type} value={type} onChange={(e) => setType(e.target.value as Account['type'])}>
          {ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.inst}>Institution (optional)</label>
        <input id={ids.inst} value={institution} maxLength={200} onChange={(e) => setInstitution(e.target.value)} autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor={ids.last4}>Last 4 digits (optional)</label>
        <input
          id={ids.last4}
          value={last4}
          inputMode="numeric"
          maxLength={4}
          aria-describedby={ids.hint}
          onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))}
          autoComplete="off"
        />
        <p id={ids.hint} className="hint">
          Helps match imported statements to this account.
        </p>
      </div>
      <ErrorText message={error} />
      <div className="actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn primary" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
