import { useEffect, useState } from 'react'
import type { OptimizerResultDto } from '@shared/ipc'
import { ApiError, errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { formatCents } from '../lib/format'
import { currentMonth, monthLabel } from '../lib/months'
import { cadenceLabel, flagStatus, SEVERITY_LABEL, subscriptionStatus, visibleSubscriptions } from '../lib/optimizerLogic'
import { Icon } from '../components/Icon'
import { Amount } from '../components/Money'
import { ErrorText } from '../components/ui'

type Eligible = Extract<OptimizerResultDto, { spending: unknown }>

export function Optimizer() {
  const [result, setResult] = useState<OptimizerResultDto | null>(null)
  const [extras, setExtras] = useState<{ subs: Awaited<ReturnType<typeof loadSubs>>; flags: Awaited<ReturnType<typeof loadFlags>> }>({ subs: [], flags: [] })
  const [running, setRunning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    setRunning(true)
    setError(null)
    ;(async () => {
      try {
        const r = await unwrap(flujo().optimizer.run())
        const [subs, flags] = await Promise.all([loadSubs(), loadFlags()])
        if (live) {
          setResult(r)
          setExtras({ subs, flags })
        }
      } catch (err) {
        if (live) setError(err instanceof ApiError && err.code === 'OPTIMIZER_FAILED' ? 'The analysis could not finish. Try running it again.' : errorMessage(err))
      }
      if (live) setRunning(false)
    })()
    return () => {
      live = false
    }
  }, [tick])

  const refreshExtras = async () => setExtras({ subs: await loadSubs(), flags: await loadFlags() })
  const run = (call: () => Promise<unknown>, done: string) => async () => {
    setError(null)
    setMsg(null)
    try {
      await call()
      await refreshExtras()
      setMsg(done)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <section aria-labelledby="opt-title" className="stack-lg">
      <header className="page-head">
        <h1 id="opt-title">Optimizer</h1>
        <button type="button" className="btn" disabled={running} onClick={() => setTick(tick + 1)}>
          Run again
        </button>
      </header>
      <ErrorText message={error} />
      <div role="status" className="ok-text">
        {msg}
      </div>
      {running && <p role="status">Analyzing your spending&hellip;</p>}
      {!running && result && !result.eligibility.eligible && (
        <div className="empty">
          <p>
            <strong>Not enough history yet.</strong> {result.eligibility.message} You have {result.eligibility.availableMonths} complete{' '}
            {result.eligibility.availableMonths === 1 ? 'month' : 'months'} of data and the optimizer needs {result.eligibility.requiredMonths}.
          </p>
        </div>
      )}
      {!running && result?.eligibility.eligible && <Results r={result as Eligible} extras={extras} run={run} setError={setError} setMsg={setMsg} />}
    </section>
  )
}

const loadSubs = async () => unwrap(flujo().optimizer.listSubscriptions())
const loadFlags = async () => unwrap(flujo().optimizer.listFlags({}))

function Results({
  r,
  extras,
  run,
  setError,
  setMsg
}: {
  r: Eligible
  extras: { subs: Awaited<ReturnType<typeof loadSubs>>; flags: Awaited<ReturnType<typeof loadFlags>> }
  run: (call: () => Promise<unknown>, done: string) => () => Promise<void>
  setError: (m: string | null) => void
  setMsg: (m: string | null) => void
}) {
  const { spending } = r
  const [month, setMonth] = useState(currentMonth())
  const [accepting, setAccepting] = useState(false)
  const subs = visibleSubscriptions(r.subscriptions, extras.subs)
  const accept = async (categoryId: string, name: string) => {
    if (accepting) return
    setAccepting(true)
    setError(null)
    setMsg(null)
    try {
      await unwrap(flujo().optimizer.acceptSuggestedBudget({ categoryId, month }))
      setMsg(`Budget for ${name} set for ${monthLabel(month)}.`)
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'CONFLICT' ? `A budget for ${name} could not be set for ${monthLabel(month)}. Check the Budgets screen.` : errorMessage(err))
    }
    setAccepting(false)
  }

  return (
    <>
      <section aria-labelledby="avg-title" className="stack">
        <h2 id="avg-title">Average spending</h2>
        <p className="muted">Based on {spending.months.length} complete months, {spending.months[0]} to {spending.months[spending.months.length - 1]}. The median ignores unusual months.</p>
        <div className="stat-grid">
          <div className="card tight stat">
            <span className="muted">Mean per month</span>
            <span className="big num">{formatCents(spending.overall.meanCents)}</span>
          </div>
          <div className="card tight stat">
            <span className="muted">Median per month</span>
            <span className="big num">{formatCents(spending.overall.medianCents)}</span>
          </div>
          {spending.highest && (
            <div className="card tight stat">
              <span className="muted">Highest category</span>
              <span className="big">{spending.highest.name}</span>
              <span className="num">
                {formatCents(spending.highest.meanCents)} a month, {Math.round(spending.highest.share * 100)}% of spending
              </span>
            </div>
          )}
        </div>
        <div className="table-wrap tall">
          <table>
            <caption className="sr-only">Average monthly spending by category</caption>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col" className="right">Mean</th>
                <th scope="col" className="right">Median</th>
                <th scope="col" className="right">Share</th>
              </tr>
            </thead>
            <tbody>
              {spending.categories.map((c) => (
                <tr key={c.categoryId ?? c.name}>
                  <th scope="row">{c.name}</th>
                  <td className="right num">{formatCents(c.meanCents)}</td>
                  <td className="right num">{formatCents(c.medianCents)}</td>
                  <td className="right num">{Math.round(c.share * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="sub-title" className="stack">
        <h2 id="sub-title">Subscriptions</h2>
        {subs.length === 0 && <p className="muted">No recurring charges detected.</p>}
        <ul className="card-grid">
          {subs.map((s) => {
            const confirmed = subscriptionStatus(s, extras.subs) === 'confirmed'
            return (
              <li key={s.merchant} className="card tight">
                <div className="row-between">
                  <h3>{s.merchant}</h3>
                  {confirmed && (
                    <span className="status ok">
                      <Icon name="check" size={14} /> Confirmed
                    </span>
                  )}
                </div>
                <p className="num">
                  {formatCents(s.amountCents)} {cadenceLabel(s.cadence)}, about {formatCents(s.annualizedCents)} a year
                </p>
                <p className="muted">
                  {s.chargeCount} charges, last on {s.lastDate}, next expected {s.nextExpected}.
                </p>
                {s.priceIncrease && (
                  <p className="status warn">
                    <Icon name="alert" size={14} /> Price went up from {formatCents(s.priceIncrease.fromCents)} to {formatCents(s.priceIncrease.toCents)} (+{Math.round(s.priceIncrease.pct)}%)
                  </p>
                )}
                {s.lapsed && (
                  <p className="status warn">
                    <Icon name="alert" size={14} /> No recent charge, it may have stopped
                  </p>
                )}
                <div className="actions start">
                  {!confirmed && (
                    <button type="button" className="btn small" aria-label={`Confirm subscription ${s.merchant}`} onClick={run(() => unwrap(flujo().optimizer.confirmSubscription({ id: s.recordId })), `${s.merchant} confirmed.`)}>
                      Confirm
                    </button>
                  )}
                  <button type="button" className="btn small" aria-label={`Reject subscription ${s.merchant}`} onClick={run(() => unwrap(flujo().optimizer.rejectSubscription({ id: s.recordId })), `${s.merchant} will no longer be suggested.`)}>
                    Not a subscription
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="flag-title" className="stack">
        <h2 id="flag-title">Flagged transactions</h2>
        <p className="muted">These charges look unusual compared with your normal spending. A flag is a prompt to take a look, not a conclusion.</p>
        {r.flags.length === 0 && <p className="muted">Nothing unusual was flagged.</p>}
        <ul className="card-grid">
          {r.flags.map((f) => {
            const status = flagStatus(f, extras.flags)
            return (
              <li key={`${f.transactionId}-${f.reasonCode}`} className="card tight">
                <div className="row-between">
                  <h3>{f.merchant}</h3>
                  <span className="badge">
                    <Icon name="alert" size={12} /> {SEVERITY_LABEL[f.severity]} severity
                  </span>
                </div>
                <p>
                  <span className="num">{f.date}</span> <Amount cents={f.amountCents} />
                </p>
                <p>{f.reason}</p>
                {status !== 'open' && (
                  <p className="status ok">
                    <Icon name="check" size={14} /> {status === 'dismissed' ? 'Marked as legitimate' : 'Marked as suspicious'}
                  </p>
                )}
                {status === 'open' && (
                  <div className="actions start">
                    <button type="button" className="btn small" aria-label={`Mark ${f.merchant} charge on ${f.date} as legitimate`} onClick={run(() => unwrap(flujo().optimizer.markFlagLegitimate({ id: f.recordId })), 'Marked as legitimate. Similar charges will not be flagged again.')}>
                      This is legitimate
                    </button>
                    <button type="button" className="btn small" aria-label={`Mark ${f.merchant} charge on ${f.date} as suspicious`} onClick={run(() => unwrap(flujo().optimizer.markFlagSuspicious({ id: f.recordId })), 'Marked as suspicious.')}>
                      This looks wrong
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section aria-labelledby="bud-title2" className="stack">
        <h2 id="bud-title2">Suggested budgets</h2>
        <div className="field narrow">
          <label htmlFor="acc-month">Set accepted budgets for</label>
          <input id="acc-month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </div>
        {r.suggestedBudgets.length === 0 && <p className="muted">No suggestions.</p>}
        <ul className="card-grid">
          {r.suggestedBudgets.map((b) => (
            <li key={b.categoryId} className="card tight">
              <h3>{b.name}</h3>
              <p className="num">
                Suggested <strong>{formatCents(b.suggestedCents)}</strong> a month
                {b.existingBudgetCents !== null ? ` (current budget ${formatCents(b.existingBudgetCents)})` : ''}
              </p>
              <p className="muted">{b.rationale}</p>
              <div className="actions start">
                <button type="button" className="btn small primary" disabled={accepting} aria-label={`Accept suggested budget for ${b.name}`} onClick={() => void accept(b.categoryId, b.name)}>
                  Accept
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
