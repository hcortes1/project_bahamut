import { useId, useState, type FormEvent } from 'react'
import type { Category } from '@shared/db-types'
import type { BudgetProgressItemDto, RecurringDto } from '@shared/ipc'
import { clampPercent, parsePositiveCents } from '../lib/amounts'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { centsToInput, formatCents, todayIso } from '../lib/format'
import { useLoad } from '../lib/hooks'
import { currentMonth, monthLabel, shiftMonth } from '../lib/months'
import { ManageCategories } from '../components/Categories'
import { Icon } from '../components/Icon'
import { Bar } from '../components/Money'
import { ConfirmDialog, Dialog, ErrorText } from '../components/ui'

const CADENCES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'] as const

type Dlg =
  | { kind: 'budget'; categoryId: string | null; amountCents: number | null }
  | { kind: 'deleteBudget'; item: BudgetProgressItemDto; budgetId: string }
  | { kind: 'bill'; bill: RecurringDto | null }
  | { kind: 'deleteBill'; bill: RecurringDto }
  | { kind: 'categories' }
  | null

export function Budgets() {
  const [month, setMonth] = useState(currentMonth())
  const [dlg, setDlg] = useState<Dlg>(null)
  const [error, setError] = useState<string | null>(null)
  const [paying, setPaying] = useState<string | null>(null)

  const cats = useLoad(() => unwrap(flujo().categories.list()))
  const prog = useLoad(
    async () => ({
      progress: await unwrap(flujo().budgets.progress({ month })),
      budgets: await unwrap(flujo().budgets.list({ month }))
    }),
    [month]
  )
  const bills = useLoad(async () => ({
    // Subscriptions the user rejected in the Optimizer stay stored (so they are not suggested again) but are not bills.
    items: (await unwrap(flujo().recurring.list({}))).filter((b) => b.status !== 'rejected'),
    due: await unwrap(flujo().recurring.dueSoon({ withinDays: 30 }))
  }))

  const categories = cats.data ?? []
  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? 'Uncategorized'
  const reloadAll = () => {
    setDlg(null)
    prog.reload()
    bills.reload()
  }
  const p = prog.data?.progress

  const markPaid = async (b: RecurringDto) => {
    if (paying) return
    setPaying(b.id)
    setError(null)
    try {
      await unwrap(flujo().recurring.markPaid({ id: b.id }))
      bills.reload()
    } catch (err) {
      setError(errorMessage(err))
    }
    setPaying(null)
  }

  return (
    <div className="stack-lg">
      <section aria-labelledby="bud-title">
        <header className="page-head">
          <h1 id="bud-title">Budgets</h1>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setDlg({ kind: 'categories' })}>
              Categories
            </button>
            <button type="button" className="btn primary" onClick={() => setDlg({ kind: 'budget', categoryId: null, amountCents: null })}>
              <Icon name="plus" size={16} /> Set budget
            </button>
          </div>
        </header>
        <div className="month-picker" role="group" aria-label="Budget month">
          <button type="button" className="btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
            Previous
          </button>
          <strong aria-live="polite">{monthLabel(month)}</strong>
          <button type="button" className="btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
            Next
          </button>
        </div>
        <ErrorText message={prog.error ?? cats.error ?? error} />
        {p && (
          <>
            <p className="muted">
              {p.label} Total budgeted <span className="num">{formatCents(p.totalBudgetCents)}</span>, spent <span className="num">{formatCents(p.totalSpentCents)}</span>.
            </p>
            {p.items.length === 0 && (
              <div className="empty">
                <p>No budgets for {monthLabel(month)}. Use Set budget to add one.</p>
              </div>
            )}
            <ul className="budget-list">
              {p.items.map((it) => {
                const used = it.percentUsed
                const b = prog.data?.budgets.find((x) => x.categoryId === it.categoryId)
                return (
                  <li key={it.categoryId} className="card tight">
                    <div className="row-between">
                      <h2 className="h-sm">{it.categoryName}</h2>
                      <div className="actions">
                        <button type="button" className="btn icon" aria-label={`Edit budget for ${it.categoryName}`} onClick={() => setDlg({ kind: 'budget', categoryId: it.categoryId, amountCents: it.budgetCents })}>
                          <Icon name="edit" size={16} />
                        </button>
                        <button type="button" className="btn icon" aria-label={`Delete budget for ${it.categoryName}`} disabled={!b} onClick={() => b && setDlg({ kind: 'deleteBudget', item: it, budgetId: b.id })}>
                          <Icon name="trash" size={16} />
                        </button>
                      </div>
                    </div>
                    <Bar percent={clampPercent(used)} over={it.overBudget} label={`${it.categoryName}: ${used ?? 0} percent of budget used`} />
                    <div className="row-between">
                      <span className="num">
                        {formatCents(it.spentCents)} of {formatCents(it.budgetCents)}
                      </span>
                      {it.overBudget ? (
                        <span className="status bad">
                          <Icon name="alert" size={16} /> Over budget by <span className="num">{formatCents(-it.remainingCents)}</span>
                        </span>
                      ) : (
                        <span className="status ok">
                          <Icon name="check" size={16} /> <span className="num">{formatCents(it.remainingCents)}</span> left
                        </span>
                      )}
                    </div>
                    {it.overPace === true && !it.overBudget && (
                      <span className="status warn">
                        <Icon name="alert" size={16} /> Spending faster than the month so far allows
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
            {p.unbudgeted.length > 0 && (
              <div className="card tight">
                <h2 className="h-sm">Spending without a budget</h2>
                <ul className="plain-list">
                  {p.unbudgeted.map((u) => (
                    <li key={u.categoryId ?? 'none'}>
                      {u.categoryName}: <span className="num">{formatCents(u.spentCents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="bill-title">
        <header className="page-head">
          <h2 id="bill-title">Recurring bills</h2>
          <button type="button" className="btn primary" onClick={() => setDlg({ kind: 'bill', bill: null })}>
            <Icon name="plus" size={16} /> Add bill
          </button>
        </header>
        <ErrorText message={bills.error} />
        {bills.data && bills.data.items.length === 0 && (
          <div className="empty">
            <p>No recurring bills yet. Add rent, utilities or subscriptions to track due dates.</p>
          </div>
        )}
        {bills.data && bills.data.items.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Recurring bills</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Category</th>
                  <th scope="col">Repeats</th>
                  <th scope="col">Next due</th>
                  <th scope="col" className="right">
                    Amount
                  </th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {bills.data.items.map((b) => {
                  const due = bills.data?.due.find((d) => d.id === b.id)
                  return (
                    <tr key={b.id}>
                      <th scope="row">
                        {b.name}
                        {b.isSubscription && <span className="badge">Subscription</span>}
                        {b.status !== 'active' && <span className="badge">{b.status}</span>}
                      </th>
                      <td>{catName(b.categoryId)}</td>
                      <td>{b.cadence}</td>
                      <td className="num">
                        {b.nextDue ?? 'Not set'}
                        {due && (
                          <div className={due.overdue ? 'status bad' : 'status warn'}>
                            <Icon name="alert" size={14} />
                            {due.overdue ? `Overdue by ${Math.abs(due.daysUntilDue)} days` : due.daysUntilDue === 0 ? 'Due today' : `Due in ${due.daysUntilDue} days`}
                          </div>
                        )}
                      </td>
                      <td className="right num">{formatCents(b.amountCents)}</td>
                      <td className="right nowrap">
                        <button type="button" className="btn small" disabled={!b.nextDue || paying !== null} onClick={() => void markPaid(b)} aria-label={`Mark ${b.name} as paid`}>
                          Mark paid
                        </button>
                        <button type="button" className="btn icon" aria-label={`Edit bill ${b.name}`} onClick={() => setDlg({ kind: 'bill', bill: b })}>
                          <Icon name="edit" size={16} />
                        </button>
                        <button type="button" className="btn icon" aria-label={`Delete bill ${b.name}`} onClick={() => setDlg({ kind: 'deleteBill', bill: b })}>
                          <Icon name="trash" size={16} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dlg?.kind === 'budget' && (
        <BudgetDialog month={month} categories={categories} budgeted={(p?.items ?? []).map((i) => i.categoryId)} init={dlg} onClose={() => setDlg(null)} onSaved={reloadAll} />
      )}
      {dlg?.kind === 'deleteBudget' && (
        <ConfirmDialog
          title="Delete this budget?"
          confirmLabel="Delete budget"
          onClose={() => setDlg(null)}
          onConfirm={async () => {
            await unwrap(flujo().budgets.delete({ id: dlg.budgetId }))
            reloadAll()
          }}
        >
          <p>
            This deletes the <span className="num">{formatCents(dlg.item.budgetCents)}</span> budget for {dlg.item.categoryName} in {monthLabel(month)}. Transactions are not changed.
          </p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'bill' && <BillDialog bill={dlg.bill} categories={categories} onClose={() => setDlg(null)} onSaved={reloadAll} />}
      {dlg?.kind === 'deleteBill' && (
        <ConfirmDialog
          title={`Delete ${dlg.bill.name}?`}
          confirmLabel="Delete bill"
          onClose={() => setDlg(null)}
          onConfirm={async () => {
            await unwrap(flujo().recurring.delete({ id: dlg.bill.id }))
            reloadAll()
          }}
        >
          <p>
            This deletes the recurring bill {dlg.bill.name} (<span className="num">{formatCents(dlg.bill.amountCents)}</span>, {dlg.bill.cadence}). Past transactions are not changed.
          </p>
        </ConfirmDialog>
      )}
      {dlg?.kind === 'categories' && <ManageCategories categories={categories} onClose={() => setDlg(null)} onChanged={() => { cats.reload(); prog.reload() }} />}
    </div>
  )
}

function CategoryOptions({ categories, only }: { categories: Category[]; only?: (c: Category) => boolean }) {
  return (
    <>
      {categories
        .filter(only ?? (() => true))
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </>
  )
}

function BudgetDialog({
  month,
  categories,
  budgeted,
  init,
  onClose,
  onSaved
}: {
  month: string
  categories: Category[]
  budgeted: string[]
  init: { categoryId: string | null; amountCents: number | null }
  onClose: () => void
  onSaved: () => void
}) {
  const editing = init.categoryId !== null
  const options = categories.filter((c) => c.kind === 'expense' && (editing ? c.id === init.categoryId : !budgeted.includes(c.id)))
  const [categoryId, setCategoryId] = useState(init.categoryId ?? options[0]?.id ?? '')
  const [amount, setAmount] = useState(init.amountCents !== null ? centsToInput(init.amountCents) : '')
  const [error, setError] = useState<string | null>(null)
  const ids = { c: useId(), a: useId() }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const cents = parsePositiveCents(amount)
    if (!categoryId) return setError('Choose a category.')
    if (cents === null) return setError('Enter a monthly amount greater than zero.')
    try {
      await unwrap(flujo().budgets.set({ categoryId, month, amountCents: cents }))
      onSaved()
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Dialog title={`${editing ? 'Edit' : 'Set'} budget for ${monthLabel(month)}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="field">
          <label htmlFor={ids.c}>Category</label>
          <select id={ids.c} value={categoryId} disabled={editing} onChange={(e) => setCategoryId(e.target.value)}>
            <CategoryOptions categories={options} />
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.a}>Monthly budget (USD)</label>
          <input id={ids.a} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        {options.length === 0 && <p className="muted">Every expense category already has a budget this month.</p>}
        <ErrorText message={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save budget
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function BillDialog({ bill, categories, onClose, onSaved }: { bill: RecurringDto | null; categories: Category[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(bill?.name ?? '')
  const [amount, setAmount] = useState(bill ? centsToInput(bill.amountCents) : '')
  const [cadence, setCadence] = useState(bill?.cadence ?? 'monthly')
  const [nextDue, setNextDue] = useState(bill?.nextDue ?? todayIso())
  const [categoryId, setCategoryId] = useState(bill?.categoryId ?? '')
  const [isSub, setIsSub] = useState(bill?.isSubscription ?? false)
  const [status, setStatus] = useState(bill?.status ?? 'active')
  const [error, setError] = useState<string | null>(null)
  const ids = { n: useId(), a: useId(), c: useId(), d: useId(), k: useId(), s: useId() }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const cents = parsePositiveCents(amount)
    if (name.trim() === '') return setError('Enter a name.')
    if (cents === null) return setError('Enter an amount greater than zero.')
    const body = {
      name: name.trim(),
      amountCents: cents,
      cadence: cadence as (typeof CADENCES)[number],
      nextDue: nextDue || null,
      categoryId: categoryId || null,
      isSubscription: isSub,
      status: status as 'active' | 'paused' | 'cancelled'
    }
    try {
      if (bill) await unwrap(flujo().recurring.update({ id: bill.id, patch: body }))
      else await unwrap(flujo().recurring.create(body))
      onSaved()
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Dialog title={bill ? 'Edit bill' : 'Add bill'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="field">
          <label htmlFor={ids.n}>Name</label>
          <input id={ids.n} value={name} maxLength={200} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.a}>Amount (USD)</label>
            <input id={ids.a} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={ids.k}>Repeats</label>
            <select id={ids.k} value={cadence} onChange={(e) => setCadence(e.target.value)}>
              {CADENCES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.d}>Next due</label>
            <input id={ids.d} type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={ids.s}>Status</label>
            <select id={ids.s} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="cancelled">cancelled</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.c}>Category</label>
          <select id={ids.c} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">None</option>
            <CategoryOptions categories={categories} only={(c) => c.kind === 'expense'} />
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={isSub} onChange={(e) => setIsSub(e.target.checked)} /> This is a subscription
        </label>
        <ErrorText message={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save bill
          </button>
        </div>
      </form>
    </Dialog>
  )
}
