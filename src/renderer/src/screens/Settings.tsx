import { useId, useState, type FormEvent } from 'react'
import type { Category } from '@shared/db-types'
import type { AuthStatusDto, ChangeOutcome, RuleDto, SettingsDto } from '@shared/ipc'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { formatCountdown, todayIso } from '../lib/format'
import { useLoad } from '../lib/hooks'
import {
  CredentialInputs,
  credentialsFilled,
  emptyCredentials,
  toCredentials,
  type CredentialValues
} from '../components/Credentials'
import { Icon } from '../components/Icon'
import { ConfirmDialog, Dialog, ErrorText, WipeList } from '../components/ui'

const IDLE_MINUTES = [1, 2, 5, 10, 15, 30, 60]

export function Settings({ onWiped }: { onWiped: () => void }) {
  const { data, error, reload } = useLoad(async () => ({
    status: await unwrap(flujo().auth.status()),
    settings: await unwrap(flujo().settings.get())
  }))
  return (
    <div className="settings">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <ErrorText message={error} />
      {data && (
        <>
          <SecuritySection status={data.status} settings={data.settings} onCredentialChanged={reload} />
          <RulesSection />
          <DataSection status={data.status} onWiped={onWiped} />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- security, imports

const CHANGE_REASONS: Record<Exclude<ChangeOutcome, { changed: true }>['reason'], string> = {
  invalid_format: 'The new value is not valid. A PIN is 4 to 8 digits; a password is at least 8 characters.',
  would_remove_last_credential: 'You cannot remove your only credential.',
  not_enabled: 'That credential is not set up.',
  not_configured: 'Flujo has no credentials set up.',
  invalid_input: 'Check the values you entered.',
  locked: 'Too many failed attempts.',
  invalid: 'The current credentials are incorrect.'
}

function SecuritySection({ status, settings, onCredentialChanged }: { status: AuthStatusDto; settings: SettingsDto; onCredentialChanged: () => void }) {
  const [idleMin, setIdleMin] = useState(String(Math.round(settings.idleTimeoutMs / 60_000)))
  const [lockOnMinimize, setLockOnMinimize] = useState(settings.lockOnMinimize)
  const [retain, setRetain] = useState(settings.retainImports)
  const [threshold, setThreshold] = useState(String(Math.round(settings.importConfidenceThreshold * 100)))
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const ids = { idle: useId(), thr: useId(), thrHint: useId() }

  const options = IDLE_MINUTES.includes(Number(idleMin)) ? IDLE_MINUTES : [...IDLE_MINUTES, Number(idleMin)].sort((a, b) => a - b)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const pct = Number(threshold)
    if (!Number.isInteger(pct) || pct < 5 || pct > 100) return setError('Confidence threshold must be a whole number from 5 to 100.')
    if (saving) return
    setSaving(true)
    setError(null)
    setMsg(null)
    try {
      await unwrap(
        flujo().settings.update({
          idleTimeoutMs: Number(idleMin) * 60_000,
          lockOnMinimize,
          retainImports: retain,
          importConfidenceThreshold: pct / 100
        })
      )
      setMsg('Settings saved.')
    } catch (err) {
      setError(errorMessage(err))
    }
    setSaving(false)
  }

  return (
    <>
      <section className="card" aria-labelledby="sec-title">
        <h2 id="sec-title">Security</h2>
        <ChangeCredential status={status} onChanged={onCredentialChanged} />
        <form onSubmit={save} className="stack">
          <h3>Locking and imports</h3>
          <div className="field">
            <label htmlFor={ids.idle}>Lock after being idle for</label>
            <select id={ids.idle} value={idleMin} onChange={(e) => setIdleMin(e.target.value)}>
              {options.map((m) => (
                <option key={m} value={m}>
                  {m} {m === 1 ? 'minute' : 'minutes'}
                </option>
              ))}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={lockOnMinimize} onChange={(e) => setLockOnMinimize(e.target.checked)} />
            Lock when the window is minimized
          </label>
          <label className="check">
            <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
            Keep imported statement files after import
          </label>
          <div className="field">
            <label htmlFor={ids.thr}>Confidence threshold for imports (%)</label>
            <input
              id={ids.thr}
              type="number"
              min={5}
              max={100}
              step={5}
              value={threshold}
              aria-describedby={ids.thrHint}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <p id={ids.thrHint} className="hint">
              Imported rows categorized with less confidence than this need your review.
            </p>
          </div>
          <ErrorText message={error} />
          <div role="status" className="ok-text">
            {msg && (
              <>
                <Icon name="check" size={16} /> {msg}
              </>
            )}
          </div>
          <div className="actions start">
            <button type="submit" className="btn primary" disabled={saving}>
              Save settings
            </button>
          </div>
        </form>
      </section>
    </>
  )
}

function ChangeCredential({ status, onChanged }: { status: AuthStatusDto; onChanged: () => void }) {
  const { pinEnabled, passwordEnabled } = status
  const [chosen, setChosen] = useState<'pin' | 'password'>(pinEnabled ? 'pin' : 'password')
  const [current, setCurrent] = useState<CredentialValues>(emptyCredentials)
  const [next, setNext] = useState('')
  const [next2, setNext2] = useState('')
  const [remove, setRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const both = pinEnabled && passwordEnabled
  const kind = both ? chosen : pinEnabled ? 'pin' : 'password'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (!credentialsFilled(current, pinEnabled, passwordEnabled)) return setError('Enter your current credentials.')
    if (!remove) {
      if (kind === 'pin' && !/^\d{4,8}$/.test(next)) return setError('The new PIN must be 4 to 8 digits.')
      if (kind === 'password' && next.length < 8) return setError('The new password must be at least 8 characters.')
      if (next !== next2) return setError('The two new values do not match.')
    }
    setBusy(true)
    setError(null)
    try {
      const out = await unwrap(
        flujo().auth.changeCredential({
          current: toCredentials(current, pinEnabled, passwordEnabled),
          kind,
          next: remove ? null : next
        })
      )
      if (out.changed) {
        setRemove(false)
        onChanged()
        setMsg(remove ? `The ${kind === 'pin' ? 'PIN' : 'password'} was removed.` : `Your ${kind === 'pin' ? 'PIN' : 'password'} was changed.`)
      } else {
        const wait = out.retryAfterMs ? ` Try again in ${formatCountdown(out.retryAfterMs)}.` : ''
        setError(CHANGE_REASONS[out.reason] + wait)
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setCurrent(emptyCredentials)
      setNext('')
      setNext2('')
    }
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="stack">
      <h3>Change credential</h3>
      {both && (
        <fieldset className="field">
          <legend>Credential to change</legend>
          <label className="check">
            <input type="radio" name="kind" checked={kind === 'pin'} onChange={() => setChosen('pin')} /> PIN
          </label>
          <label className="check">
            <input type="radio" name="kind" checked={kind === 'password'} onChange={() => setChosen('password')} /> Password
          </label>
        </fieldset>
      )}
      <p className="muted">Enter your current {both ? 'PIN and password' : pinEnabled ? 'PIN' : 'password'} to make this change.</p>
      <CredentialInputs value={current} onChange={setCurrent} pinEnabled={pinEnabled} passwordEnabled={passwordEnabled} disabled={busy} />
      {both && (
        <label className="check">
          <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} />
          Remove the {kind === 'pin' ? 'PIN' : 'password'} instead (Flujo then unlocks with the other one only)
        </label>
      )}
      {!remove && (
        <div className="grid-2">
          <div className="field">
            <label htmlFor="new1">New {kind === 'pin' ? 'PIN (4 to 8 digits)' : 'password (at least 8 characters)'}</label>
            <input
              id="new1"
              type="password"
              autoComplete="off"
              inputMode={kind === 'pin' ? 'numeric' : undefined}
              maxLength={kind === 'pin' ? 8 : undefined}
              value={next}
              onChange={(e) => setNext(kind === 'pin' ? e.target.value.replace(/\D/g, '') : e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="new2">Confirm new {kind === 'pin' ? 'PIN' : 'password'}</label>
            <input
              id="new2"
              type="password"
              autoComplete="off"
              inputMode={kind === 'pin' ? 'numeric' : undefined}
              maxLength={kind === 'pin' ? 8 : undefined}
              value={next2}
              onChange={(e) => setNext2(kind === 'pin' ? e.target.value.replace(/\D/g, '') : e.target.value)}
            />
          </div>
        </div>
      )}
      <ErrorText message={error} />
      <div role="status" className="ok-text">
        {msg && (
          <>
            <Icon name="check" size={16} /> {msg}
          </>
        )}
      </div>
      <div className="actions start">
        <button type="submit" className="btn" disabled={busy}>
          {remove ? 'Remove credential' : 'Change credential'}
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- learned rules

function RulesSection() {
  const { data, error, reload } = useLoad(async () => ({
    rules: await unwrap(flujo().categorizer.listLearnedRules()),
    categories: await unwrap(flujo().categories.list())
  }))
  const [editing, setEditing] = useState<RuleDto | null>(null)
  const [deleting, setDeleting] = useState<RuleDto | null>(null)
  const nameOf = (id: string) => data?.categories.find((c) => c.id === id)?.name ?? 'Unknown category'

  return (
    <section className="card" aria-labelledby="rules-title">
      <h2 id="rules-title">Learned categorization rules</h2>
      <p className="muted">Flujo learns a rule when you correct a category. Edit or delete rules that are wrong.</p>
      <ErrorText message={error} />
      {data && data.rules.length === 0 && <p>No learned rules yet.</p>}
      {data && data.rules.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Learned categorization rules</caption>
            <thead>
              <tr>
                <th scope="col">Pattern</th>
                <th scope="col">Category</th>
                <th scope="col" className="right">
                  Weight
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.pattern}</th>
                  <td>{nameOf(r.categoryId)}</td>
                  <td className="right num">{r.weight}</td>
                  <td className="right nowrap">
                    <button type="button" className="btn icon" aria-label={`Edit rule ${r.pattern}`} onClick={() => setEditing(r)}>
                      <Icon name="edit" size={16} />
                    </button>
                    <button type="button" className="btn icon" aria-label={`Delete rule ${r.pattern}`} onClick={() => setDeleting(r)}>
                      <Icon name="trash" size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && data && (
        <RuleEditor
          rule={editing}
          categories={data.categories}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this rule?"
          confirmLabel="Delete rule"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await unwrap(flujo().categorizer.deleteLearnedRule({ id: deleting.id }))
            setDeleting(null)
            reload()
          }}
        >
          <p>
            This deletes the learned rule &ldquo;{deleting.pattern}&rdquo; ({nameOf(deleting.categoryId)}). Transactions already categorized are not changed.
          </p>
        </ConfirmDialog>
      )}
    </section>
  )
}

function RuleEditor({
  rule,
  categories,
  onClose,
  onSaved
}: {
  rule: RuleDto
  categories: Category[]
  onClose: () => void
  onSaved: () => void
}) {
  const [pattern, setPattern] = useState(rule.pattern)
  const [categoryId, setCategoryId] = useState(rule.categoryId)
  const [weight, setWeight] = useState(String(rule.weight))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ids = { p: useId(), c: useId(), w: useId() }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const w = Number(weight)
    if (pattern.trim() === '') return setError('Enter a pattern.')
    if (!(w > 0 && w <= 1000)) return setError('Weight must be greater than 0 and at most 1000.')
    setBusy(true)
    try {
      await unwrap(flujo().categorizer.editLearnedRule({ id: rule.id, patch: { pattern: pattern.trim(), categoryId, weight: w } }))
      onSaved()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Dialog title="Edit rule" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="field">
          <label htmlFor={ids.p}>Pattern</label>
          <input id={ids.p} value={pattern} maxLength={200} onChange={(e) => setPattern(e.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor={ids.c}>Category</label>
          <select id={ids.c} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.w}>Weight</label>
          <input id={ids.w} type="number" min={0.01} max={1000} step="any" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </div>
        <ErrorText message={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Save rule
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ---------------------------------------------------------------- data

const WIPE_REASONS = {
  locked: 'Too many failed attempts.',
  invalid: 'The current credentials are incorrect.',
  not_configured: 'Flujo has no credentials set up.',
  invalid_input: 'Check the values you entered.'
} as const

function DataSection({ status, onWiped }: { status: AuthStatusDto; onWiped: () => void }) {
  const [kind, setKind] = useState<'transactions' | 'summary'>('transactions')
  const [from, setFrom] = useState(() => `${new Date().getFullYear()}-01-01`)
  const [to, setTo] = useState(todayIso())
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wipe, setWipe] = useState(false)
  const ids = { kind: useId(), from: useId(), to: useId() }

  const exportCsv = async (e: FormEvent) => {
    e.preventDefault()
    setMsg(null)
    if (!from || !to || from > to) return setError('Choose a start date on or before the end date.')
    setError(null)
    try {
      const out = await unwrap(flujo().export.csv({ kind, range: { from, to } }))
      setMsg(out.saved ? 'Export saved.' : 'Export cancelled. No file was saved.')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <section className="card" aria-labelledby="data-title">
      <h2 id="data-title">Data</h2>
      <form onSubmit={exportCsv} className="stack">
        <h3>Export CSV</h3>
        <div className="grid-3">
          <div className="field">
            <label htmlFor={ids.kind}>What to export</label>
            <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as 'transactions' | 'summary')}>
              <option value="transactions">Transactions</option>
              <option value="summary">Summary (monthly income, expenses and net, plus spending by category; transfers excluded)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.from}>From</label>
            <input id={ids.from} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={ids.to}>To</label>
            <input id={ids.to} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <ErrorText message={error} />
        <div role="status" className="ok-text">
          {msg}
        </div>
        <div className="actions start">
          <button type="submit" className="btn">
            Export CSV
          </button>
        </div>
      </form>

      <div className="danger-zone stack">
        <h3>Wipe all local data</h3>
        <p>Deletes everything Flujo has stored on this computer and returns it to first-run setup.</p>
        <div className="actions start">
          <button type="button" className="btn danger" onClick={() => setWipe(true)}>
            <Icon name="trash" size={16} /> Wipe all local data
          </button>
        </div>
      </div>

      {wipe && <WipeDialog status={status} onClose={() => setWipe(false)} onWiped={onWiped} />}
    </section>
  )
}

function WipeDialog({ status, onClose, onWiped }: { status: AuthStatusDto; onClose: () => void; onWiped: () => void }) {
  const { pinEnabled, passwordEnabled } = status
  const [creds, setCreds] = useState<CredentialValues>(emptyCredentials)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!credentialsFilled(creds, pinEnabled, passwordEnabled)) return setError('Enter your current credentials.')
    setBusy(true)
    setError(null)
    try {
      const out = await unwrap(flujo().data.wipe({ current: toCredentials(creds, pinEnabled, passwordEnabled), confirmWipe: true }))
      if (out.wiped) return onWiped()
      const wait = out.retryAfterMs ? ` Try again in ${formatCountdown(out.retryAfterMs)}.` : ''
      setError(WIPE_REASONS[out.reason] + wait)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setCreds(emptyCredentials)
    }
    setBusy(false)
  }

  return (
    <Dialog title="Wipe all local data?" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p>This permanently deletes:</p>
        <WipeList />
        <p>This cannot be undone. Enter your current credentials to continue.</p>
        <CredentialInputs value={creds} onChange={setCreds} pinEnabled={pinEnabled} passwordEnabled={passwordEnabled} disabled={busy} />
        <ErrorText message={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={busy}>
            Wipe all local data
          </button>
        </div>
      </form>
    </Dialog>
  )
}
