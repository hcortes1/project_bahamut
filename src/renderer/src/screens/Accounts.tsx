import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Account } from '@shared/db-types'
import type { BalanceDto } from '@shared/ipc'
import { accountTypeLabel } from '../lib/accountTypes'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { formatCents, parseAmountInput, todayIso } from '../lib/format'
import { useLoad } from '../lib/hooks'
import { AccountForm } from '../components/AccountForm'
import { CentsChart } from '../components/CentsChart'
import { Icon } from '../components/Icon'
import { ConfirmDialog, Dialog, ErrorText } from '../components/ui'

interface Loaded {
  accounts: Account[]
  balances: Record<string, BalanceDto[]>
}

async function loadAll(): Promise<Loaded> {
  const accounts = await unwrap(flujo().accounts.list())
  const lists = await Promise.all(accounts.map((a) => unwrap(flujo().accounts.listBalances({ accountId: a.id }))))
  const balances: Record<string, BalanceDto[]> = {}
  accounts.forEach((a, i) => {
    balances[a.id] = [...(lists[i] ?? [])].sort((x, y) => x.date.localeCompare(y.date))
  })
  return { accounts, balances }
}

type Dialogs = { kind: 'create' } | { kind: 'edit'; account: Account } | { kind: 'delete'; account: Account } | null

export function Accounts() {
  const { data, error, reload } = useLoad(loadAll)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialogs>(null)

  const selected = data?.accounts.find((a) => a.id === selectedId) ?? null

  return (
    <div className={selected ? 'with-drawer' : undefined}>
      <section aria-labelledby="accounts-title">
        <header className="page-head">
          <h1 id="accounts-title">Accounts</h1>
          <button type="button" className="btn primary" onClick={() => setDialog({ kind: 'create' })}>
            <Icon name="plus" size={16} /> Add account
          </button>
        </header>
        <ErrorText message={error} />
        {data && data.accounts.length === 0 && (
          <div className="empty">
            <p>No accounts yet. Add one to start tracking balances and importing statements.</p>
          </div>
        )}
        {data && data.accounts.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Accounts. Select an account name to see its balance history.</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Institution</th>
                  <th scope="col">Last 4</th>
                  <th scope="col" className="right">
                    Latest balance
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a) => {
                  const list = data.balances[a.id] ?? []
                  const latest = list[list.length - 1]
                  return (
                    <tr key={a.id} aria-selected={a.id === selectedId || undefined} className={a.id === selectedId ? 'selected' : undefined}>
                      <th scope="row">
                        <button type="button" className="link" aria-expanded={a.id === selectedId} onClick={() => setSelectedId(a.id === selectedId ? null : a.id)}>
                          {a.name}
                        </button>
                      </th>
                      <td>{accountTypeLabel(a.type)}</td>
                      <td>{a.institution ?? '-'}</td>
                      <td className="num">{a.last4 ?? '-'}</td>
                      <td className="right num">{latest ? `${formatCents(latest.balanceCents)} (${latest.date})` : 'No balance recorded'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && data && (
        <Drawer
          key={selected.id}
          account={selected}
          balances={data.balances[selected.id] ?? []}
          onClose={() => setSelectedId(null)}
          onEdit={() => setDialog({ kind: 'edit', account: selected })}
          onDelete={() => setDialog({ kind: 'delete', account: selected })}
          onChanged={reload}
        />
      )}

      {dialog?.kind === 'create' && (
        <Dialog title="Add account" onClose={() => setDialog(null)}>
          <AccountForm
            submitLabel="Add account"
            onCancel={() => setDialog(null)}
            onSubmit={async (v) => {
              const a = await unwrap(flujo().accounts.create(v))
              setDialog(null)
              setSelectedId(a.id)
              reload()
            }}
          />
        </Dialog>
      )}
      {dialog?.kind === 'edit' && (
        <Dialog title="Edit account" onClose={() => setDialog(null)}>
          <AccountForm
            initial={dialog.account}
            submitLabel="Save changes"
            onCancel={() => setDialog(null)}
            onSubmit={async (v) => {
              await unwrap(flujo().accounts.update({ id: dialog.account.id, patch: v }))
              setDialog(null)
              reload()
            }}
          />
        </Dialog>
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${dialog.account.name}?`}
          confirmLabel="Delete account"
          typeToConfirm="DELETE"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await unwrap(flujo().accounts.delete({ id: dialog.account.id }))
            setDialog(null)
            setSelectedId(null)
            reload()
          }}
        >
          <p>This deletes:</p>
          <ul className="plain-list">
            <li>the account {dialog.account.name}</li>
            <li>all of its transactions</li>
            <li>all of its balance snapshots</li>
          </ul>
          <p>If a transfer involves this account, the other side of it stays in the other account. Statement files already kept are not deleted. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

function Drawer({
  account,
  balances,
  onClose,
  onEdit,
  onDelete,
  onChanged
}: {
  account: Account
  balances: BalanceDto[]
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onChanged: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [asTable, setAsTable] = useState(false)
  const [date, setDate] = useState(todayIso())
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<BalanceDto | null>(null)

  useEffect(() => heading.current?.focus(), [])

  const record = async (e: FormEvent) => {
    e.preventDefault()
    const cents = parseAmountInput(amount)
    if (cents === null) return setError('Enter a valid amount, for example 1234.56 or -250.00.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError('Choose a date.')
    setBusy(true)
    setError(null)
    try {
      await unwrap(flujo().accounts.recordBalance({ accountId: account.id, date, balanceCents: cents }))
      setAmount('')
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    }
    setBusy(false)
  }

  const labels = useMemo(() => balances.map((b) => b.date), [balances])
  const series = useMemo(() => [{ label: 'Balance', data: balances.map((b) => b.balanceCents) }], [balances])
  const summary = balances.length
    ? `Balance history for ${account.name}: ${balances.length} snapshots from ${balances[0]?.date} to ${balances[balances.length - 1]?.date}.`
    : `No balance history for ${account.name}.`

  return (
    <aside className="drawer" aria-labelledby="drawer-title">
      <div className="dialog-head">
        <h2 id="drawer-title" tabIndex={-1} ref={heading}>
          {account.name}
        </h2>
        <button type="button" className="btn icon" aria-label="Close account details" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="actions start">
        <button type="button" className="btn" onClick={onEdit}>
          <Icon name="edit" size={16} /> Edit
        </button>
        <button type="button" className="btn danger-outline" onClick={onDelete}>
          <Icon name="trash" size={16} /> Delete
        </button>
      </div>

      <h3>Balance history</h3>
      {balances.length === 0 ? (
        <p className="muted">No snapshots yet. Record the balance below.</p>
      ) : (
        <>
          <button type="button" className="btn small" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
            {asTable ? 'Show chart' : 'Show as table'}
          </button>
          {asTable ? (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">{summary}</caption>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col" className="right">
                      Balance
                    </th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...balances].reverse().map((b) => (
                    <tr key={b.id}>
                      <th scope="row" className="num">
                        {b.date}
                      </th>
                      <td className="right num">{formatCents(b.balanceCents)}</td>
                      <td className="right">
                        <button type="button" className="btn icon" aria-label={`Delete snapshot from ${b.date}`} onClick={() => setRemoving(b)}>
                          <Icon name="trash" size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <CentsChart type="line" labels={labels} series={series} ariaLabel={summary} />
          )}
        </>
      )}

      <form onSubmit={record} className="stack">
        <h3>Record balance</h3>
        <div className="field">
          <label htmlFor="snap-date">Date</label>
          <input id="snap-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="snap-amt">Balance (USD)</label>
          <input id="snap-amt" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <ErrorText message={error} />
        <button type="submit" className="btn primary" disabled={busy}>
          Record balance
        </button>
      </form>

      {removing && (
        <ConfirmDialog
          title="Delete balance snapshot?"
          confirmLabel="Delete snapshot"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await unwrap(flujo().accounts.deleteBalance({ id: removing.id }))
            setRemoving(null)
            onChanged()
          }}
        >
          <p>
            This deletes the <span className="num">{formatCents(removing.balanceCents)}</span> balance recorded for {account.name} on{' '}
            <span className="num">{removing.date}</span>. Nothing else is deleted.
          </p>
        </ConfirmDialog>
      )}
    </aside>
  )
}
