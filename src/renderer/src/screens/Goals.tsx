import { useMemo, useState, type FormEvent } from 'react'
import type { ContributionDto, GoalDto, GoalProjectionDto } from '@shared/ipc'
import { clampPercent, parsePositiveCents, signedCents, type Direction } from '../lib/amounts'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { projectionText } from '../lib/goalText'
import { centsToInput, formatCents, parseAmountInput, todayIso } from '../lib/format'
import { useLoad } from '../lib/hooks'
import { currentMonth, monthLabel, shiftMonth } from '../lib/months'
import { ChartPanel } from '../components/ChartPanel'
import { Icon } from '../components/Icon'
import { Amount, Bar } from '../components/Money'
import { ConfirmDialog, Dialog, ErrorText } from '../components/ui'

type Dlg =
  | { kind: 'goal'; goal: GoalDto | null }
  | { kind: 'deleteGoal'; goal: GoalDto }
  | { kind: 'contrib'; goal: GoalDto }
  | null

export function Goals() {
  const [dlg, setDlg] = useState<Dlg>(null)
  const to = currentMonth()
  const nw = useLoad(async () => ({
    current: await unwrap(flujo().netWorth.current({})),
    history: await unwrap(flujo().netWorth.history({ fromMonth: shiftMonth(to, -11), toMonth: to })),
    accounts: await unwrap(flujo().accounts.list())
  }))
  const goals = useLoad(async () => {
    const list = await unwrap(flujo().goals.list())
    const projections = await Promise.all(list.map((g) => unwrap(flujo().goals.projection({ goalId: g.id }))))
    return list.map((g, i) => ({ goal: g, projection: projections[i] as GoalProjectionDto }))
  })

  const history = nw.data?.history ?? []
  const labels = useMemo(() => history.map((h) => (h.partial ? `${monthLabel(h.month)} (so far)` : monthLabel(h.month))), [history])
  const series = useMemo(() => [{ label: 'Net worth', data: history.map((h) => h.netWorthCents) }], [history])
  const cur = nw.data?.current
  const missing = (cur?.accountsWithoutSnapshot ?? []).map((id) => nw.data?.accounts.find((a) => a.id === id)?.name ?? 'an account')
  const done = () => {
    setDlg(null)
    goals.reload()
    nw.reload()
  }

  return (
    <div className="stack-lg">
      <section aria-labelledby="nw-title">
        <header className="page-head">
          <h1 id="nw-title">Goals &amp; Net Worth</h1>
        </header>
        <ErrorText message={nw.error} />
        {cur && (
          <>
            <div className="stat-grid">
              <div className="card tight stat">
                <span className="muted">Net worth</span>
                <span className="big num">{formatCents(cur.netWorthCents)}</span>
              </div>
              <div className="card tight stat">
                <span className="muted">Assets</span>
                <span className="big num">{formatCents(cur.assetsCents)}</span>
              </div>
              <div className="card tight stat">
                <span className="muted">Debt</span>
                <span className="big num">{formatCents(cur.liabilitiesCents)}</span>
              </div>
            </div>
            <p className="muted">As of {cur.asOf}, from your latest recorded balance for each account.</p>
            {missing.length > 0 && (
              <p className="notice warn">
                <Icon name="alert" />
                <span>Not counted, no balance recorded yet: {missing.join(', ')}. Record a balance on the Accounts screen.</span>
              </p>
            )}
            <ChartPanel
              title="Net worth, last 12 months"
              type="line"
              labels={labels}
              series={series}
              rowHeader="Month"
              summary={`Net worth by month: ${history.length} points${history.length ? `, latest ${formatCents(history[history.length - 1]?.netWorthCents ?? 0)}` : ''}.`}
            />
          </>
        )}
      </section>

      <section aria-labelledby="goal-title">
        <header className="page-head">
          <h2 id="goal-title">Savings goals</h2>
          <button type="button" className="btn primary" onClick={() => setDlg({ kind: 'goal', goal: null })}>
            <Icon name="plus" size={16} /> Add goal
          </button>
        </header>
        <ErrorText message={goals.error} />
        {goals.data && goals.data.length === 0 && (
          <div className="empty">
            <p>No goals yet. Add a target, then record contributions to see a projected finish date.</p>
          </div>
        )}
        <ul className="card-grid">
          {goals.data?.map(({ goal: g, projection: p }) => {
            const pct = Math.floor((g.currentCents * 100) / g.targetCents)
            return (
              <li key={g.id} className="card tight">
                <div className="row-between">
                  <h3>{g.name}</h3>
                  <div className="actions">
                    <button type="button" className="btn icon" aria-label={`Edit goal ${g.name}`} onClick={() => setDlg({ kind: 'goal', goal: g })}>
                      <Icon name="edit" size={16} />
                    </button>
                    <button type="button" className="btn icon" aria-label={`Delete goal ${g.name}`} onClick={() => setDlg({ kind: 'deleteGoal', goal: g })}>
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </div>
                <Bar percent={clampPercent(pct)} label={`${g.name}: ${pct} percent saved`} />
                <div className="row-between">
                  <span className="num">
                    {formatCents(g.currentCents)} of {formatCents(g.targetCents)} ({pct}%)
                  </span>
                  <span className="muted">{g.targetDate ? `Target ${g.targetDate}` : 'No target date'}</span>
                </div>
                <p className="muted">{projectionText(p)}</p>
                <div className="actions start">
                  <button type="button" className="btn" onClick={() => setDlg({ kind: 'contrib', goal: g })}>
                    Contributions
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      {dlg?.kind === 'goal' && <GoalDialog goal={dlg.goal} onClose={() => setDlg(null)} onSaved={done} />}
      {dlg?.kind === 'deleteGoal' && (
        <ConfirmDialog
          title={`Delete ${dlg.goal.name}?`}
          confirmLabel="Delete goal"
          onClose={() => setDlg(null)}
          onConfirm={async () => {
            await unwrap(flujo().goals.delete({ id: dlg.goal.id }))
            done()
          }}
        >
          <p>
            This deletes the goal {dlg.goal.name} (target <span className="num">{formatCents(dlg.goal.targetCents)}</span>) and all of its contributions. Your accounts and transactions are not changed.
          </p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'contrib' && <ContribDialog goal={dlg.goal} onClose={done} />}
    </div>
  )
}

function GoalDialog({ goal, onClose, onSaved }: { goal: GoalDto | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(goal?.name ?? '')
  const [target, setTarget] = useState(goal ? centsToInput(goal.targetCents) : '')
  const [targetDate, setTargetDate] = useState(goal?.targetDate ?? '')
  const [opening, setOpening] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const t = parsePositiveCents(target)
    if (name.trim() === '') return setError('Enter a goal name.')
    if (t === null) return setError('Enter a target amount greater than zero.')
    const open = opening.trim() === '' ? 0 : parseAmountInput(opening)
    if (open === null || open < 0) return setError('Starting amount must be zero or more.')
    try {
      if (goal) await unwrap(flujo().goals.update({ id: goal.id, patch: { name: name.trim(), targetCents: t, targetDate: targetDate || null } }))
      else
        await unwrap(
          flujo().goals.create({ name: name.trim(), targetCents: t, targetDate: targetDate || null, ...(open > 0 ? { openingCents: open, openingDate: todayIso() } : {}) })
        )
      onSaved()
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Dialog title={goal ? 'Edit goal' : 'Add goal'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="field">
          <label htmlFor="g-name">Goal name</label>
          <input id="g-name" value={name} maxLength={200} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="g-target">Target amount (USD)</label>
            <input id="g-target" inputMode="decimal" autoComplete="off" value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="g-date">Target date (optional)</label>
            <input id="g-date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </div>
        </div>
        {!goal && (
          <div className="field">
            <label htmlFor="g-open">Already saved (optional, USD)</label>
            <input id="g-open" inputMode="decimal" autoComplete="off" value={opening} onChange={(e) => setOpening(e.target.value)} />
          </div>
        )}
        <ErrorText message={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save goal
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function ContribDialog({ goal, onClose }: { goal: GoalDto; onClose: () => void }) {
  const list = useLoad(async () => (await unwrap(flujo().goals.listContributions({ goalId: goal.id }))).sort((a, b) => b.date.localeCompare(a.date)))
  const [editing, setEditing] = useState<ContributionDto | null>(null)
  const [deleting, setDeleting] = useState<ContributionDto | null>(null)
  const [date, setDate] = useState(todayIso())
  const [dir, setDir] = useState<Direction>('income')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)

  const startEdit = (c: ContributionDto) => {
    setEditing(c)
    setDate(c.date)
    setDir(c.amountCents < 0 ? 'expense' : 'income')
    setAmount(centsToInput(Math.abs(c.amountCents)))
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const pos = parsePositiveCents(amount)
    if (pos === null) return setError('Enter an amount greater than zero.')
    const cents = signedCents(dir, pos)
    setError(null)
    try {
      if (editing) await unwrap(flujo().goals.updateContribution({ id: editing.id, patch: { date, amountCents: cents } }))
      else await unwrap(flujo().goals.addContribution({ goalId: goal.id, date, amountCents: cents }))
      setEditing(null)
      setAmount('')
      list.reload()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog title={`Contributions to ${goal.name}`} onClose={onClose} wide>
      <form onSubmit={submit} className="stack">
        <div className="grid-3">
          <div className="field">
            <label htmlFor="c-date">Date</label>
            <input id="c-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="c-type">Type</label>
            <select id="c-type" value={dir} onChange={(e) => setDir(e.target.value as Direction)}>
              <option value="income">Deposit</option>
              <option value="expense">Withdrawal</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-amt">Amount (USD)</label>
            <input id="c-amt" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <ErrorText message={error} />
        <div className="actions start">
          <button type="submit" className="btn primary">
            {editing ? 'Save contribution' : 'Add contribution'}
          </button>
          {editing && (
            <button type="button" className="btn" onClick={() => { setEditing(null); setAmount('') }}>
              Cancel edit
            </button>
          )}
        </div>
      </form>
      <ErrorText message={list.error} />
      {list.data && list.data.length === 0 && <p className="muted">No contributions yet.</p>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap tall">
          <table>
            <caption className="sr-only">Contributions</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" className="right">Amount</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <th scope="row" className="num">{c.date}</th>
                  <td className="right"><Amount cents={c.amountCents} /></td>
                  <td className="right nowrap">
                    <button type="button" className="btn icon" aria-label={`Edit contribution on ${c.date}`} onClick={() => startEdit(c)}>
                      <Icon name="edit" size={16} />
                    </button>
                    <button type="button" className="btn icon" aria-label={`Delete contribution on ${c.date}`} onClick={() => setDeleting(c)}>
                      <Icon name="trash" size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this contribution?"
          confirmLabel="Delete contribution"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await unwrap(flujo().goals.deleteContribution({ id: deleting.id }))
            setDeleting(null)
            list.reload()
          }}
        >
          <p>
            This deletes the <span className="num">{formatCents(deleting.amountCents)}</span> contribution to {goal.name} on <span className="num">{deleting.date}</span>. Nothing else is deleted.
          </p>
        </ConfirmDialog>
      )}
    </Dialog>
  )
}
