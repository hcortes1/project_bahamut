import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Account } from '@shared/db-types'
import type { Category } from '@shared/db-types'
import type { CommitBlockersDto, CommitResultDto, CsvMappingDto, DuplicateGroupDto, ReviewRowDto, ReviewViewDto } from '@shared/ipc'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { centsToInput, formatCents, parseAmountInput } from '../lib/format'
import { blockerMessages, canCommit, columnOptions, confidencePercent, pendingConfirmIds } from '../lib/importLogic'
import { useLoad } from '../lib/hooks'
import { Icon } from '../components/Icon'
import { Amount } from '../components/Money'
import { ConfirmDialog, Dialog, ErrorText } from '../components/ui'

export function ImportReview({
  view,
  accounts,
  retainDefault,
  onView,
  onClosed
}: {
  view: ReviewViewDto
  accounts: Account[]
  retainDefault: boolean
  onView: (v: ReviewViewDto) => void
  onClosed: (r: CommitResultDto | null) => void
}) {
  const cats = useLoad(() => unwrap(flujo().categories.list()))
  const [blockers, setBlockers] = useState<CommitBlockersDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkCat, setBulkCat] = useState('')
  const [editing, setEditing] = useState<ReviewRowDto | null>(null)
  const [keep, setKeep] = useState(retainDefault)
  const [discard, setDiscard] = useState(false)

  const categories = cats.data ?? []
  const account = accounts.find((a) => a.id === view.accountId)
  const isCard = account?.type === 'credit_card'
  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? 'Uncategorized'
  const pending = pendingConfirmIds(view.rows)

  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])

  useEffect(() => {
    let live = true
    setBlockers(null)
    unwrap(flujo().imports.blockers({ sessionId: view.id })).then(
      (b) => live && setBlockers(b),
      (e: unknown) => live && setError(errorMessage(e))
    )
    return () => {
      live = false
    }
  }, [view])

  /** Run a channel that returns the updated review view. */
  const act = async (call: () => Promise<ReviewViewDto>) => {
    setError(null)
    setBusy(true)
    try {
      onView(await call())
    } catch (err) {
      setError(errorMessage(err))
    }
    setBusy(false)
  }
  const sid = view.id

  const confirmAll = async () => {
    setError(null)
    setBusy(true)
    let latest = view
    try {
      for (const rowId of pending) latest = await unwrap(flujo().imports.confirmRow({ sessionId: sid, rowId }))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      onView(latest)
    }
    setBusy(false)
  }

  const commit = async () => {
    setError(null)
    setBusy(true)
    try {
      onClosed(await unwrap(flujo().imports.commit({ sessionId: sid, keepSourceFile: keep })))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const messages = blockers ? blockerMessages(blockers) : []

  return (
    <section aria-labelledby="rev-title" className="stack">
      <header className="page-head">
        <div>
          <h1 id="rev-title" tabIndex={-1} ref={heading}>
            Review import
          </h1>
          <p className="muted">
            {view.fileName} into {account?.name ?? 'account'}
            {view.pdf ? `, statement ${view.pdf.periodStart} to ${view.pdf.periodEnd}` : ''}
          </p>
        </div>
        <button type="button" className="btn danger-outline" onClick={() => setDiscard(true)}>
          Discard import
        </button>
      </header>
      <ErrorText message={error ?? cats.error} />

      {view.fileDuplicate && !view.fileDuplicate.acknowledged && (
        <div className="notice warn">
          <Icon name="alert" />
          <div className="stack">
            <span>
              This looks like the file <strong>{view.fileDuplicate.existingFileName}</strong>, already imported on {view.fileDuplicate.existingImportedAt.slice(0, 10)}.
            </span>
            <div className="actions start">
              <button type="button" className="btn" disabled={busy} onClick={() => void act(() => unwrap(flujo().imports.acknowledgeFileDuplicate({ sessionId: sid })))}>
                Import it again anyway
              </button>
            </div>
          </div>
        </div>
      )}
      {view.overlap.detected && (
        <p className="notice warn">
          <Icon name="alert" />
          <span>
            This file overlaps earlier imports: {view.overlap.duplicateRowCount} identical and {view.overlap.nearMatchCount} near-matching rows.
          </span>
        </p>
      )}
      {view.validation?.checked && (
        <p className={view.validation.ok ? 'notice' : 'notice warn'}>
          <Icon name={view.validation.ok ? 'check' : 'alert'} />
          <span>
            {view.validation.ok
              ? 'Balance check passed: beginning balance plus transactions equals the ending balance.'
              : `Balance check failed: the rows add up to ${formatCents(view.validation.computedEndingCents ?? 0)} but the statement ends at ${formatCents(view.validation.expectedEndingCents ?? 0)} (difference ${formatCents(view.validation.differenceCents ?? 0)}). Some rows may be missing or wrong.`}
          </span>
        </p>
      )}
      {[...(view.pdf?.warnings.map((w) => w.message) ?? []), ...(view.csv?.warnings ?? [])].map((w, i) => (
        <p key={i} className="notice">
          <Icon name="info" />
          <span>{w}</span>
        </p>
      ))}

      {view.csv && <MappingPanel view={view} busy={busy} act={act} />}

      {view.duplicateGroups.length > 0 && (
        <section aria-labelledby="dup-title" className="stack">
          <h2 id="dup-title">Possible duplicates</h2>
          {view.duplicateGroups.map((g) => (
            <DuplicateCard key={g.id} group={g} view={view} busy={busy} act={act} />
          ))}
        </section>
      )}

      <section aria-labelledby="rows-title" className="stack">
        <div className="row-between">
          <h2 id="rows-title">{view.rows.length} rows</h2>
          <div className="actions">
            {isCard && pending.length > 0 && (
              <button type="button" className="btn" disabled={busy} onClick={() => void confirmAll()}>
                Confirm all {pending.length} low-confidence rows
              </button>
            )}
          </div>
        </div>
        {isCard && pending.length > 0 && <p className="muted">Credit card statements start with every row marked low confidence. Check them, then confirm all at once.</p>}
        <div className="bulk">
          <div className="field">
            <label htmlFor="bulk-cat">Category for {selected.size} selected {selected.size === 1 ? 'row' : 'rows'}</label>
            <select id="bulk-cat" value={bulkCat} onChange={(e) => setBulkCat(e.target.value)}>
              <option value="">Choose a category</option>
              {categories.filter((c) => c.kind !== 'transfer').map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy || selected.size === 0 || !bulkCat}
            onClick={() => {
              void act(() => unwrap(flujo().imports.bulkSetCategory({ sessionId: sid, rowIds: [...selected], categoryId: bulkCat })))
              setSelected(new Set())
            }}
          >
            Apply category
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Parsed rows. Rows marked low confidence must be confirmed, edited or excluded before you can commit.</caption>
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    checked={view.rows.length > 0 && selected.size === view.rows.length}
                    onChange={(e) => setSelected(e.target.checked ? new Set(view.rows.map((r) => r.id)) : new Set())}
                  />
                </th>
                <th scope="col">Date</th>
                <th scope="col">Description</th>
                <th scope="col">Category</th>
                <th scope="col" className="right">Amount</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => {
                const needs = r.lowConfidence && !r.reviewed && !r.excluded
                return (
                  <tr key={r.id} className={needs ? 'needs-review' : r.excluded ? 'excluded' : undefined}>
                    <td>
                      <input type="checkbox" aria-label={`Select ${r.description}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </td>
                    <td className="num nowrap">{r.date}</td>
                    <th scope="row">{r.description}</th>
                    <td>{catName(r.categoryId)}</td>
                    <td className="right">
                      <Amount cents={r.amountCents} />
                    </td>
                    <td>
                      {r.excluded ? (
                        <span className="badge">Excluded</span>
                      ) : needs ? (
                        <span className="status warn">
                          <Icon name="alert" size={14} /> Low confidence ({confidencePercent(r.confidence)}%)
                        </span>
                      ) : r.reviewed ? (
                        <span className="status ok">
                          <Icon name="check" size={14} /> Confirmed
                        </span>
                      ) : (
                        <span className="muted">{confidencePercent(r.confidence)}%</span>
                      )}
                      {r.edited && <span className="badge">Edited</span>}
                      {r.duplicateGroupId && <span className="badge">Possible duplicate</span>}
                    </td>
                    <td className="right nowrap">
                      {needs && (
                        <button type="button" className="btn small" disabled={busy} onClick={() => void act(() => unwrap(flujo().imports.confirmRow({ sessionId: sid, rowId: r.id })))} aria-label={`Confirm ${r.description}`}>
                          Confirm
                        </button>
                      )}
                      <button type="button" className="btn icon" aria-label={`Edit ${r.description}`} onClick={() => setEditing(r)}>
                        <Icon name="edit" size={16} />
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled={busy}
                        onClick={() => void act(() => unwrap(flujo().imports.setExcluded({ sessionId: sid, rowId: r.id, excluded: !r.excluded })))}
                        aria-label={`${r.excluded ? 'Include' : 'Exclude'} ${r.description}`}
                      >
                        {r.excluded ? 'Include' : 'Exclude'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card tight" aria-labelledby="commit-title">
        <h2 id="commit-title" className="h-sm">Save to Flujo</h2>
        <div aria-live="polite">
          {messages.length > 0 && (
            <ul className="plain-list">
              {messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          {blockers && messages.length === 0 && (
            <p className="status ok">
              <Icon name="check" size={16} /> Ready to import {view.rows.filter((r) => !r.excluded).length} rows at most; skipped duplicates are not saved.
            </p>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep a copy of the statement file on this computer
        </label>
        <div className="actions start">
          <button type="button" className="btn primary" disabled={busy || !canCommit(blockers)} onClick={() => void commit()}>
            Commit import
          </button>
        </div>
      </section>

      {editing && (
        <EditRowDialog
          row={editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSave={async (edit) => {
            onView(await unwrap(flujo().imports.editRow({ sessionId: sid, rowId: editing.id, edit })))
            setEditing(null)
          }}
        />
      )}
      {discard && (
        <ConfirmDialog
          title="Discard this import?"
          confirmLabel="Discard import"
          onClose={() => setDiscard(false)}
          onConfirm={async () => {
            await unwrap(flujo().imports.discard({ sessionId: sid }))
            onClosed(null)
          }}
        >
          <p>
            This discards the review of <strong>{view.fileName}</strong>. Nothing has been saved yet, so no transactions are added or deleted.
          </p>
        </ConfirmDialog>
      )}
    </section>
  )
}

function DuplicateCard({ group, view, busy, act }: { group: DuplicateGroupDto; view: ReviewViewDto; busy: boolean; act: (c: () => Promise<ReviewViewDto>) => Promise<void> }) {
  const [all, setAll] = useState(false)
  const incoming = view.rows.filter((r) => group.incomingRowIds.includes(r.id))
  const decide = (decision: 'skip' | 'import') =>
    act(() => unwrap(flujo().imports.resolveDuplicate({ sessionId: view.id, groupId: group.id, decision, applyToAllRemaining: all })))
  return (
    <div className="card tight">
      <div className="compare">
        <div>
          <h3>Already in Flujo</h3>
          <ul className="plain-list">
            {group.existing.map((e) => (
              <li key={e.id}>
                <span className="num">{e.date}</span> {e.description} <span className="num">{formatCents(e.amountCents)}</span> ({e.source})
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>In this file</h3>
          <ul className="plain-list">
            {incoming.map((r) => (
              <li key={r.id}>
                <span className="num">{r.date}</span> {r.description} <span className="num">{formatCents(r.amountCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {group.decision !== 'pending' && <p className="status ok"><Icon name="check" size={14} /> Decision: {group.decision === 'skip' ? 'skip the rows in this file' : 'import them anyway'}</p>}
      <div className="actions start">
        <button type="button" className="btn" disabled={busy} onClick={() => void decide('skip')}>
          Skip (already imported)
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void decide('import')}>
          Import anyway
        </button>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Apply to all remaining duplicates
        </label>
      </div>
    </div>
  )
}

function MappingPanel({ view, busy, act }: { view: ReviewViewDto; busy: boolean; act: (c: () => Promise<ReviewViewDto>) => Promise<void> }) {
  const csv = view.csv
  const [m, setM] = useState<CsvMappingDto | undefined>(csv?.mapping)
  // Reset local choices only when the server-side mapping changes (after Apply), not on every refresh.
  const mappingKey = JSON.stringify(csv?.mapping)
  useEffect(() => setM(csv?.mapping), [mappingKey])
  const idp = useId()
  if (!csv || !m) return null
  const cols = columnOptions(csv.headers)
  const colSelect = (label: string, value: number | null, onChange: (v: number | null) => void, key: string) => (
    <div className="field">
      <label htmlFor={`${idp}-${key}`}>{label}</label>
      <select id={`${idp}-${key}`} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">Not used</option>
        {cols.map((c) => (
          <option key={c.index} value={c.index}>
            {c.label}
          </option>
        ))}
      </select>
    </div>
  )
  const apply = (e: FormEvent) => {
    e.preventDefault()
    void act(() =>
      unwrap(
        flujo().imports.setMapping({
          sessionId: view.id,
          mapping: {
            hasHeader: m.hasHeader,
            date: { index: m.date.index },
            description: { index: m.description.index },
            amount: { mode: m.amount.mode, amountIndex: m.amount.amountIndex, debitIndex: m.amount.debitIndex, creditIndex: m.amount.creditIndex },
            dateOrder: m.dateOrder,
            invertSign: m.invertSign
          }
        })
      )
    )
  }
  return (
    <form onSubmit={apply} className="card tight" aria-labelledby={`${idp}-t`}>
      <h2 id={`${idp}-t`} className="h-sm">CSV column mapping</h2>
      <p className="muted">
        Detected with {confidencePercent(csv.mappingConfidence)}% confidence. {csv.needsConfirmation && !csv.confirmed ? 'Check the columns, change them if needed, then confirm.' : 'Mapping confirmed.'} Skipped {csv.skipped.total} rows (blank {csv.skipped.blank}, summary {csv.skipped.summary}, invalid {csv.skipped.invalid}).
      </p>
      <div className="grid-3">
        {colSelect('Date column', m.date.index, (v) => setM({ ...m, date: { ...m.date, index: v } }), 'date')}
        {colSelect('Description column', m.description.index, (v) => setM({ ...m, description: { ...m.description, index: v } }), 'desc')}
        <div className="field">
          <label htmlFor={`${idp}-mode`}>Amounts are in</label>
          <select id={`${idp}-mode`} value={m.amount.mode} onChange={(e) => setM({ ...m, amount: { ...m.amount, mode: e.target.value as 'single' | 'split' } })}>
            <option value="single">One signed column</option>
            <option value="split">Separate debit and credit columns</option>
          </select>
        </div>
        {m.amount.mode === 'single' ? (
          colSelect('Amount column', m.amount.amountIndex, (v) => setM({ ...m, amount: { ...m.amount, amountIndex: v } }), 'amt')
        ) : (
          <>
            {colSelect('Debit column', m.amount.debitIndex, (v) => setM({ ...m, amount: { ...m.amount, debitIndex: v } }), 'deb')}
            {colSelect('Credit column', m.amount.creditIndex, (v) => setM({ ...m, amount: { ...m.amount, creditIndex: v } }), 'cre')}
          </>
        )}
        <div className="field">
          <label htmlFor={`${idp}-order`}>Date order</label>
          <select id={`${idp}-order`} value={m.dateOrder} onChange={(e) => setM({ ...m, dateOrder: e.target.value as CsvMappingDto['dateOrder'] })}>
            <option value="MDY">Month/Day/Year</option>
            <option value="DMY">Day/Month/Year</option>
            <option value="YMD">Year-Month-Day</option>
          </select>
          {(m.dateOrderAmbiguous || m.dateOrderConflict) && <p className="hint">The date order is ambiguous in this file. Check a few dates below.</p>}
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={m.hasHeader} onChange={(e) => setM({ ...m, hasHeader: e.target.checked })} /> The first row is a header
      </label>
      <label className="check">
        <input type="checkbox" checked={m.invertSign} onChange={(e) => setM({ ...m, invertSign: e.target.checked })} /> Flip the sign of every amount (purchases are positive in this file)
      </label>
      <p className="hint">Applying a new mapping discards row edits.</p>
      <div className="actions start">
        <button type="submit" className="btn" disabled={busy}>
          Apply mapping
        </button>
        {csv.needsConfirmation && !csv.confirmed && (
          <button type="button" className="btn primary" disabled={busy} onClick={() => void act(() => unwrap(flujo().imports.confirmMapping({ sessionId: view.id })))}>
            Confirm mapping
          </button>
        )}
      </div>
    </form>
  )
}

function EditRowDialog({
  row,
  categories,
  onClose,
  onSave
}: {
  row: ReviewRowDto
  categories: Category[]
  onClose: () => void
  onSave: (e: { date: string; amountCents: number; description: string; categoryId: string }) => Promise<void>
}) {
  const [date, setDate] = useState(row.date)
  const [amount, setAmount] = useState(centsToInput(row.amountCents))
  const [description, setDescription] = useState(row.description)
  const [categoryId, setCategoryId] = useState(row.categoryId)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const cents = parseAmountInput(amount)
    if (cents === null || cents === 0) return setError('Enter a valid non-zero amount, negative for money out.')
    if (description.trim() === '') return setError('Enter a description.')
    setBusy(true)
    try {
      await onSave({ date, amountCents: cents, description: description.trim(), categoryId })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <Dialog title="Edit row" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <div className="grid-2">
          <div className="field">
            <label htmlFor="er-date">Date</label>
            <input id="er-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="er-amt">Amount (negative is money out)</label>
            <input id="er-amt" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="er-desc">Description</label>
          <input id="er-desc" value={description} maxLength={2000} autoComplete="off" onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="er-cat">Category</label>
          <select id="er-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {categories.filter((c) => c.kind !== 'transfer').map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <p className="hint">Original: {row.original.date}, {formatCents(row.original.amountCents)}, {row.original.description}</p>
        <ErrorText message={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Save row
          </button>
        </div>
      </form>
    </Dialog>
  )
}
