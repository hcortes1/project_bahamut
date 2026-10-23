import { useId, useState, type FormEvent } from 'react'
import type { Account, Category, Transaction } from '@shared/db-types'
import type { CorrectionResultDto } from '@shared/ipc'
import { directionOf, parsePositiveCents, signedCents, splitPage, type Direction } from '../lib/amounts'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { centsToInput, formatCents, todayIso } from '../lib/format'
import { useLoad } from '../lib/hooks'
import { ManageCategories } from '../components/Categories'
import { Icon } from '../components/Icon'
import { Amount } from '../components/Money'
import { ConfirmDialog, Dialog, ErrorText } from '../components/ui'

const PAGE = 50

type DialogState =
  | { kind: 'tx'; tx: Transaction | null }
  | { kind: 'transfer'; initial: TransferInit | null }
  | { kind: 'deleteTx'; tx: Transaction }
  | { kind: 'deleteTransfer'; initial: TransferInit }
  | { kind: 'categories' }
  | { kind: 'reapply'; result: CorrectionResultDto; categoryId: string }
  | null

interface TransferInit {
  linkId: string
  fromAccountId: string
  toAccountId: string
  date: string
  amountCents: number
  description: string
}

export function Transactions() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [accountId, setAccountId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const ref = useLoad(async () => ({
    accounts: await unwrap(flujo().accounts.list()),
    categories: await unwrap(flujo().categories.list())
  }))
  const list = useLoad(
    async () => {
      const rows = await unwrap(
        flujo().transactions.list({
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(accountId ? { accountId } : {}),
          ...(categoryId ? { categoryId } : {}),
          limit: PAGE + 1,
          offset: page * PAGE
        })
      )
      return splitPage(rows, PAGE)
    },
    [from, to, accountId, categoryId, page]
  )

  const accounts = ref.data?.accounts ?? []
  const categories = ref.data?.categories ?? []
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'Unknown account'
  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? 'Uncategorized'
  const rows = (list.data?.rows ?? []).filter((t) => {
    const q = search.trim().toLowerCase()
    return q === '' || t.descriptionRaw.toLowerCase().includes(q) || (t.merchant ?? '').toLowerCase().includes(q)
  })
  const filter = (set: (v: string) => void) => (v: string) => {
    set(v)
    setPage(0)
  }

  const changeCategory = async (tx: Transaction, newCategoryId: string) => {
    setActionError(null)
    try {
      const result = await unwrap(flujo().categorizer.recordCorrection({ transactionId: tx.id, categoryId: newCategoryId }))
      list.reload()
      if (result.reapplyCandidates.length > 0) setDialog({ kind: 'reapply', result, categoryId: newCategoryId })
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  const openTransfer = async (tx: Transaction) => {
    setActionError(null)
    try {
      const same = await unwrap(flujo().transactions.list({ from: tx.date, to: tx.date }))
      const legs = same.filter((t) => t.transferLinkId === tx.transferLinkId)
      const out = legs.find((t) => t.amountCents < 0)
      const inn = legs.find((t) => t.amountCents > 0)
      if (!out || !inn || !tx.transferLinkId) return setActionError('This transfer could not be loaded.')
      setDialog({
        kind: 'transfer',
        initial: { linkId: tx.transferLinkId, fromAccountId: out.accountId, toAccountId: inn.accountId, date: tx.date, amountCents: inn.amountCents, description: out.descriptionRaw }
      })
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  const done = () => {
    setDialog(null)
    list.reload()
  }

  return (
    <section aria-labelledby="tx-title">
      <header className="page-head">
        <h1 id="tx-title">Transactions</h1>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setDialog({ kind: 'categories' })}>
            Categories
          </button>
          <button type="button" className="btn" disabled={accounts.length < 2} onClick={() => setDialog({ kind: 'transfer', initial: null })}>
            <Icon name="swap" size={16} /> Transfer
          </button>
          <button type="button" className="btn primary" disabled={accounts.length === 0} onClick={() => setDialog({ kind: 'tx', tx: null })}>
            <Icon name="plus" size={16} /> Add transaction
          </button>
        </div>
      </header>

      <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter transactions">
        <div className="field">
          <label htmlFor="f-from">From</label>
          <input id="f-from" type="date" value={from} onChange={(e) => filter(setFrom)(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-to">To</label>
          <input id="f-to" type="date" value={to} onChange={(e) => filter(setTo)(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-acc">Account</label>
          <select id="f-acc" value={accountId} onChange={(e) => filter(setAccountId)(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-cat">Category</label>
          <select id="f-cat" value={categoryId} onChange={(e) => filter(setCategoryId)(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-q">Search this page</label>
          <input id="f-q" type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoComplete="off" />
        </div>
      </form>

      <ErrorText message={list.error ?? ref.error ?? actionError} />
      {list.data && (
        <p className="muted" role="status">
          Showing {rows.length} {rows.length === 1 ? 'transaction' : 'transactions'} on page {page + 1}
          {search.trim() !== '' && list.data.rows.length !== rows.length ? ` (${list.data.rows.length} on this page before search)` : ''}.
        </p>
      )}
      {list.data && list.data.rows.length === 0 && (
        <div className="empty">
          <p>No transactions match. {page === 0 ? 'Add one, import a statement, or widen the filters.' : 'This page is empty.'}</p>
        </div>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Transactions, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Description</th>
                <th scope="col">Category</th>
                <th scope="col">Account</th>
                <th scope="col" className="right">
                  Amount
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const isTransfer = t.transferLinkId !== null
                return (
                  <tr key={t.id}>
                    <td className="num nowrap">{t.date}</td>
                    <th scope="row">
                      {t.merchant || t.descriptionRaw}
                      {t.merchant && <div className="muted small-text">{t.descriptionRaw}</div>}
                    </th>
                    <td>
                      {isTransfer || t.isTransfer ? (
                        <>
                          <span className="badge">
                            <Icon name="swap" size={12} /> Transfer
                          </span>
                          <div className="muted small-text">Excluded from totals</div>
                        </>
                      ) : (
                        <select
                          aria-label={`Category for ${t.merchant || t.descriptionRaw} on ${t.date}`}
                          value={t.categoryId ?? ''}
                          onChange={(e) => void changeCategory(t, e.target.value)}
                        >
                          {t.categoryId === null && <option value="">Uncategorized</option>}
                          {categories
                            .filter((c) => c.kind !== 'transfer')
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      )}
                    </td>
                    <td>{accountName(t.accountId)}</td>
                    <td className="right">
                      <Amount cents={t.amountCents} />
                    </td>
                    <td className="right nowrap">
                      <button
                        type="button"
                        className="btn icon"
                        aria-label={`Edit ${isTransfer ? 'transfer' : 'transaction'} ${t.merchant || t.descriptionRaw} on ${t.date}`}
                        onClick={() => (isTransfer ? void openTransfer(t) : setDialog({ kind: 'tx', tx: t }))}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pager" aria-label="Pages">
        <button type="button" className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>
          Previous page
        </button>
        <button type="button" className="btn" disabled={!list.data?.hasNext} onClick={() => setPage(page + 1)}>
          Next page
        </button>
      </nav>

      {dialog?.kind === 'tx' && (
        <TxDialog
          tx={dialog.tx}
          accounts={accounts}
          categories={categories}
          onClose={() => setDialog(null)}
          onSaved={done}
          onDelete={dialog.tx && dialog.tx.source === 'manual' ? () => setDialog({ kind: 'deleteTx', tx: dialog.tx as Transaction }) : undefined}
        />
      )}
      {dialog?.kind === 'transfer' && (
        <TransferDialog
          initial={dialog.initial}
          accounts={accounts}
          onClose={() => setDialog(null)}
          onSaved={done}
          onDelete={dialog.initial ? () => setDialog({ kind: 'deleteTransfer', initial: dialog.initial as TransferInit }) : undefined}
        />
      )}
      {dialog?.kind === 'deleteTx' && (
        <ConfirmDialog
          title="Delete this transaction?"
          confirmLabel="Delete transaction"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await unwrap(flujo().transactions.delete({ id: dialog.tx.id }))
            done()
          }}
        >
          <p>
            This deletes the transaction &ldquo;{dialog.tx.descriptionRaw}&rdquo; of <span className="num">{formatCents(dialog.tx.amountCents)}</span> on{' '}
            <span className="num">{dialog.tx.date}</span> from {accountName(dialog.tx.accountId)}. Nothing else is deleted.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'deleteTransfer' && (
        <ConfirmDialog
          title="Delete this transfer?"
          confirmLabel="Delete transfer"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await unwrap(flujo().transactions.deleteTransfer({ linkId: dialog.initial.linkId }))
            done()
          }}
        >
          <p>
            This deletes both sides of the <span className="num">{formatCents(dialog.initial.amountCents)}</span> transfer on{' '}
            <span className="num">{dialog.initial.date}</span>: the withdrawal from {accountName(dialog.initial.fromAccountId)} and the deposit to{' '}
            {accountName(dialog.initial.toAccountId)}.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'categories' && (
        <ManageCategories
          categories={categories}
          onClose={() => setDialog(null)}
          onChanged={() => {
            ref.reload()
            list.reload()
          }}
        />
      )}
      {dialog?.kind === 'reapply' && (
        <ConfirmDialog
          title="Apply to similar transactions?"
          confirmLabel={`Re-categorize ${dialog.result.reapplyCandidates.length}`}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await unwrap(
              flujo().categorizer.reapply({ transactionIds: dialog.result.reapplyCandidates.map((t) => t.id), categoryId: dialog.categoryId })
            )
            done()
          }}
        >
          <p>
            Flujo will remember this correction for future imports.{dialog.result.shadowedByUserRule ? ' One of your own rules takes priority over it for this merchant.' : ''}
          </p>
          <p>
            {dialog.result.reapplyCandidates.length} other {dialog.result.reapplyCandidates.length === 1 ? 'transaction' : 'transactions'} from the same
            merchant {dialog.result.reapplyCandidates.length === 1 ? 'is' : 'are'} in a different category. Move {dialog.result.reapplyCandidates.length === 1 ? 'it' : 'them'} to{' '}
            {catName(dialog.categoryId)}? Only their category changes.
          </p>
        </ConfirmDialog>
      )}
    </section>
  )
}

function TxDialog({
  tx,
  accounts,
  categories,
  onClose,
  onSaved,
  onDelete
}: {
  tx: Transaction | null
  accounts: Account[]
  categories: Category[]
  onClose: () => void
  onSaved: () => void
  onDelete?: () => void
}) {
  const [dir, setDir] = useState<Direction>(tx ? directionOf(tx.amountCents) : 'expense')
  const [accountId, setAccountId] = useState(tx?.accountId ?? accounts[0]?.id ?? '')
  const [date, setDate] = useState(tx?.date ?? todayIso())
  const [amount, setAmount] = useState(tx ? centsToInput(Math.abs(tx.amountCents)) : '')
  const [description, setDescription] = useState(tx?.descriptionRaw ?? '')
  const [merchant, setMerchant] = useState(tx?.merchant ?? '')
  const [categoryId, setCategoryId] = useState(tx?.categoryId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ids = { acc: useId(), date: useId(), amt: useId(), desc: useId(), mer: useId(), cat: useId() }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const pos = parsePositiveCents(amount)
    if (pos === null) return setError('Enter an amount greater than zero, for example 12.50.')
    if (description.trim() === '') return setError('Enter a description.')
    if (!date) return setError('Choose a date.')
    setBusy(true)
    setError(null)
    try {
      const body = { date, amountCents: signedCents(dir, pos), description: description.trim(), merchant: merchant.trim() || null, categoryId: categoryId || null }
      if (tx) await unwrap(flujo().transactions.update({ id: tx.id, patch: body }))
      else await unwrap(flujo().transactions.create({ ...body, accountId }))
      onSaved()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Dialog title={tx ? 'Edit transaction' : 'Add transaction'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <fieldset className="field">
          <legend>Type</legend>
          <div className="seg">
            <label className="check">
              <input type="radio" name="dir" checked={dir === 'expense'} onChange={() => setDir('expense')} /> Expense
            </label>
            <label className="check">
              <input type="radio" name="dir" checked={dir === 'income'} onChange={() => setDir('income')} /> Income
            </label>
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor={ids.acc}>Account</label>
          <select id={ids.acc} value={accountId} disabled={tx !== null} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.date}>Date</label>
            <input id={ids.date} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={ids.amt}>Amount (USD)</label>
            <input id={ids.amt} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.desc}>Description</label>
          <input id={ids.desc} value={description} maxLength={500} autoComplete="off" onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.mer}>Merchant (optional)</label>
          <input id={ids.mer} value={merchant} maxLength={200} autoComplete="off" onChange={(e) => setMerchant(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.cat}>Category</label>
          <select id={ids.cat} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorized</option>
            {categories
              .filter((c) => c.kind !== 'transfer')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </div>
        <ErrorText message={error} />
        <div className="actions">
          {onDelete && (
            <button type="button" className="btn danger-outline push-left" onClick={onDelete}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Save transaction
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function TransferDialog({
  initial,
  accounts,
  onClose,
  onSaved,
  onDelete
}: {
  initial: TransferInit | null
  accounts: Account[]
  onClose: () => void
  onSaved: () => void
  onDelete?: () => void
}) {
  const [fromId, setFromId] = useState(initial?.fromAccountId ?? accounts[0]?.id ?? '')
  const [toId, setToId] = useState(initial?.toAccountId ?? accounts[1]?.id ?? '')
  const [date, setDate] = useState(initial?.date ?? todayIso())
  const [amount, setAmount] = useState(initial ? centsToInput(initial.amountCents) : '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ids = { from: useId(), to: useId(), date: useId(), amt: useId(), desc: useId() }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const pos = parsePositiveCents(amount)
    if (pos === null) return setError('Enter an amount greater than zero.')
    if (fromId === toId) return setError('Choose two different accounts.')
    setBusy(true)
    setError(null)
    try {
      const body = { fromAccountId: fromId, toAccountId: toId, date, amountCents: pos, description: description.trim() || 'Transfer' }
      if (initial) await unwrap(flujo().transactions.updateTransfer({ linkId: initial.linkId, patch: body }))
      else await unwrap(flujo().transactions.createTransfer(body))
      onSaved()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Dialog title={initial ? 'Edit transfer' : 'Add transfer'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="muted">Transfers move money between your accounts. They are excluded from income, expense and budget totals.</p>
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.from}>From account</label>
            <select id={ids.from} value={fromId} onChange={(e) => setFromId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.to}>To account</label>
            <select id={ids.to} value={toId} onChange={(e) => setToId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.date}>Date</label>
            <input id={ids.date} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={ids.amt}>Amount (USD)</label>
            <input id={ids.amt} inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.desc}>Description (optional)</label>
          <input id={ids.desc} value={description} maxLength={500} autoComplete="off" onChange={(e) => setDescription(e.target.value)} />
        </div>
        <ErrorText message={error} />
        <div className="actions">
          {onDelete && (
            <button type="button" className="btn danger-outline push-left" onClick={onDelete}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Save transfer
          </button>
        </div>
      </form>
    </Dialog>
  )
}
