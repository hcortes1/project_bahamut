import { useMemo, useState } from 'react'
import { unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { formatCents } from '../lib/format'
import { useLoad } from '../lib/hooks'
import { defaultRange, incomeShape, spendingShape, trendShape } from '../lib/dashboardShape'
import { ChartPanel } from '../components/ChartPanel'
import { Bar } from '../components/Money'
import { Amount } from '../components/Money'
import { Dialog, ErrorText } from '../components/ui'

export function Dashboard() {
  const initial = defaultRange()
  const [from, setFrom] = useState(initial.from)
  const [to, setTo] = useState(initial.to)
  const [accountId, setAccountId] = useState('')
  const [drill, setDrill] = useState<{ categoryId: string; name: string } | null>(null)

  const accounts = useLoad(() => unwrap(flujo().accounts.list()))
  const valid = from !== '' && to !== '' && from <= to
  const data = useLoad(
    async () => {
      if (!valid) return null
      const filter = { from, to, ...(accountId ? { accountId } : {}) }
      const [spending, trend, income, categories, merchants] = await Promise.all([
        unwrap(flujo().dashboard.spendingByMonth(filter)),
        unwrap(flujo().dashboard.trend({ filter })),
        unwrap(flujo().dashboard.incomeVsExpenses(filter)),
        unwrap(flujo().dashboard.byCategory(filter)),
        unwrap(flujo().dashboard.topMerchants({ filter, limit: 10 }))
      ])
      return { spending, trend, income, categories, merchants, filter }
    },
    [from, to, accountId]
  )

  const d = data.data
  const spend = useMemo(() => spendingShape(d?.spending ?? []), [d])
  const trend = useMemo(() => trendShape(d?.trend ?? { window: 3, points: [] }), [d])
  const inc = useMemo(() => incomeShape(d?.income ?? []), [d])
  const empty = d !== null && d !== undefined && d.spending.length === 0 && d.income.length === 0 && d.categories.length === 0
  const maxCat = Math.max(1, ...(d?.categories ?? []).map((c) => Math.abs(c.expenseCents)))
  const hasPartial = d?.spending.some((s) => s.partial) ?? false

  return (
    <section aria-labelledby="dash-title" className="stack">
      <header className="page-head">
        <h1 id="dash-title">Dashboard</h1>
      </header>
      <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Dashboard filters">
        <div className="field">
          <label htmlFor="d-from">From</label>
          <input id="d-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="d-to">To</label>
          <input id="d-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="d-acc">Account</label>
          <select id="d-acc" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </form>
      <ErrorText message={!valid ? 'Choose a start date on or before the end date.' : (data.error ?? accounts.error)} />
      {empty && (
        <div className="empty">
          <p>No spending or income in this range. Import a statement or add transactions, or widen the dates.</p>
        </div>
      )}
      {d && !empty && (
        <>
          <p className="muted">
            Transfers between your accounts and deleted transactions are not counted.
            {hasPartial ? ' The current month is partial: it only includes days so far.' : ''}
            {d.spending.length === 1 ? ' Only one month of data is in this range.' : ''}
          </p>
          <div className="chart-grid">
            <ChartPanel
              title="Spending by month"
              type="bar"
              labels={spend.labels}
              series={spend.series}
              rowHeader="Month"
              summary={`Bar chart of monthly spending, ${spend.labels.length} months.`}
            />
            <ChartPanel
              title="Monthly trend"
              type="line"
              labels={trend.labels}
              series={trend.series}
              rowHeader="Month"
              summary={`Line chart of monthly spending with a trailing ${d.trend.window}-month average, ${trend.labels.length} months.`}
            />
            <ChartPanel
              title="Income vs. expenses"
              type="bar"
              labels={inc.labels}
              series={inc.series}
              rowHeader="Month"
              summary={`Bars of income and expenses per month with a dashed net line, ${inc.labels.length} months.`}
            />
          </div>

          <div className="chart-grid">
            <section className="card tight" aria-labelledby="cat-title">
              <h2 id="cat-title" className="h-sm">Spending by category</h2>
              {d.categories.length === 0 && <p className="muted">No spending in this range.</p>}
              <ul className="rank-list">
                {d.categories.map((c) => (
                  <li key={c.categoryId ?? c.categoryName}>
                    <div className="row-between">
                      {c.categoryId ? (
                        <button type="button" className="link" onClick={() => setDrill({ categoryId: c.categoryId as string, name: c.categoryName })}>
                          {c.categoryName}
                        </button>
                      ) : (
                        <span>{c.categoryName}</span>
                      )}
                      <span className="num">{formatCents(c.expenseCents)}</span>
                    </div>
                    <Bar percent={Math.max(0, Math.round((c.expenseCents * 100) / maxCat))} label={`${c.categoryName}: ${formatCents(c.expenseCents)}`} />
                  </li>
                ))}
              </ul>
            </section>
            <section className="card tight" aria-labelledby="mer-title">
              <h2 id="mer-title" className="h-sm">Top merchants</h2>
              {d.merchants.length === 0 && <p className="muted">No merchants in this range.</p>}
              {d.merchants.length > 0 && (
                <ol className="rank-list">
                  {d.merchants.map((m) => (
                    <li key={m.merchant} className="row-between">
                      <span>
                        {m.merchant} <span className="muted">({m.count})</span>
                      </span>
                      <span className="num">{formatCents(m.expenseCents)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        </>
      )}
      {drill && d && <DrillDown filter={d.filter} categoryId={drill.categoryId} name={drill.name} onClose={() => setDrill(null)} />}
    </section>
  )
}

const DRILL_LIMIT = 200

function DrillDown({ filter, categoryId, name, onClose }: { filter: { from: string; to: string; accountId?: string }; categoryId: string; name: string; onClose: () => void }) {
  const list = useLoad(() => unwrap(flujo().dashboard.drillDown({ filter, categoryId, limit: DRILL_LIMIT })))
  return (
    <Dialog title={`${name}: transactions`} onClose={onClose} wide>
      <ErrorText message={list.error} />
      {list.data && list.data.length === 0 && <p className="muted">No transactions.</p>}
      {list.data && list.data.length >= DRILL_LIMIT && <p className="muted">Showing the first {DRILL_LIMIT} transactions. Narrow the date range to see the rest.</p>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap tall">
          <table>
            <caption className="sr-only">Transactions in {name}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Description</th>
                <th scope="col" className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={t.id}>
                  <td className="num nowrap">{t.date}</td>
                  <th scope="row">{t.merchant || t.descriptionRaw}</th>
                  <td className="right"><Amount cents={t.amountCents} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  )
}
