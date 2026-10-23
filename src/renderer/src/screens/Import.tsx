import { useEffect, useRef, useState } from 'react'
import type { ImportRecord } from '@shared/db-types'
import type { CommitResultDto, DeleteRetainedDto, ReviewViewDto } from '@shared/ipc'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { useLoad } from '../lib/hooks'
import { Icon } from '../components/Icon'
import { Dialog, ErrorText } from '../components/ui'
import { ImportReview } from './ImportReview'

export function Import() {
  const ref = useLoad(async () => ({
    accounts: await unwrap(flujo().accounts.list()),
    imports: await unwrap(flujo().imports.list()),
    settings: await unwrap(flujo().settings.get())
  }))
  const [accountId, setAccountId] = useState('')
  const [review, setReview] = useState<ReviewViewDto | null>(null)
  const [result, setResult] = useState<CommitResultDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ImportRecord | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const wasReviewing = useRef(false)

  // Returning from a review: put focus on the page heading.
  useEffect(() => {
    if (review) wasReviewing.current = true
    else if (wasReviewing.current) {
      wasReviewing.current = false
      heading.current?.focus()
    }
  }, [review])

  const accounts = ref.data?.accounts ?? []
  const chosen = accountId || accounts[0]?.id || ''

  const choose = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const out = await unwrap(flujo().imports.open({ accountId: chosen }))
      if (!out.cancelled) setReview(out.review)
    } catch (err) {
      setError(errorMessage(err))
    }
    setBusy(false)
  }

  if (review && ref.data) {
    return (
      <ImportReview
        view={review}
        accounts={accounts}
        retainDefault={ref.data.settings.retainImports}
        onView={setReview}
        onClosed={(r) => {
          setReview(null)
          setResult(r)
          ref.reload()
        }}
      />
    )
  }

  return (
    <section aria-labelledby="imp-title" className="stack-lg">
      <div>
        <header className="page-head">
          <h1 id="imp-title" tabIndex={-1} ref={heading}>
            Import
          </h1>
        </header>
        <ErrorText message={ref.error ?? error} />
        {result && (
          <p className="notice" role="status">
            <Icon name="check" />
            <span>
              Imported {result.inserted} {result.inserted === 1 ? 'transaction' : 'transactions'}. Skipped {result.skippedDuplicates} duplicates and excluded {result.excluded} rows.{' '}
              {result.retained ? 'A copy of the statement file was kept.' : 'The statement file was not kept.'}
            </span>
          </p>
        )}
        {accounts.length === 0 && ref.data ? (
          <div className="empty">
            <p>Add an account on the Accounts screen first, then import a statement into it.</p>
          </div>
        ) : (
          <div className="card">
            <p>Choose a Bank of America PDF statement or a CSV file. You review every row before anything is saved.</p>
            <div className="field">
              <label htmlFor="imp-acc">Import into account</label>
              <select id="imp-acc" value={chosen} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="actions start">
              <button type="button" className="btn primary" disabled={busy || !chosen} onClick={() => void choose()}>
                <Icon name="import" size={16} /> {busy ? 'Reading file...' : 'Choose file'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div>
        <h2>Past imports</h2>
        {ref.data && ref.data.imports.length === 0 && <p className="muted">No imports yet.</p>}
        {ref.data && ref.data.imports.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Past imports</caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Type</th>
                  <th scope="col">Imported</th>
                  <th scope="col" className="right">Rows</th>
                  <th scope="col">Kept file</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {ref.data.imports.map((i) => (
                  <tr key={i.id}>
                    <th scope="row">{i.fileName}</th>
                    <td>{i.fileType.toUpperCase()}</td>
                    <td className="num">{i.importedAt.slice(0, 10)}</td>
                    <td className="right num">{i.rowCount}</td>
                    <td>{i.retainedFilePath ? 'Kept' : 'Not kept'}</td>
                    <td className="right">
                      {i.retainedFilePath && (
                        <button type="button" className="btn danger-outline small" onClick={() => setDeleting(i)} aria-label={`Delete kept file for ${i.fileName}`}>
                          Delete kept file
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleting && (
        <DeleteRetained
          rec={deleting}
          onClose={() => {
            setDeleting(null)
            ref.reload()
          }}
        />
      )}
    </section>
  )
}

function DeleteRetained({ rec, onClose }: { rec: ImportRecord; onClose: () => void }) {
  const [result, setResult] = useState<DeleteRetainedDto | null>(null)
  const [alsoTx, setAlsoTx] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await unwrap(flujo().imports.deleteRetained({ importId: rec.id, alsoDeleteTransactions: alsoTx })))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <Dialog title="Delete kept statement file?" onClose={onClose}>
      {result ? (
        <div className="stack" role="status">
          <p>
            {result.fileDeleted ? `The kept copy of ${rec.fileName} was deleted.` : `No kept copy of ${rec.fileName} was found.`} {result.transactionsDeleted} {result.transactionsDeleted === 1 ? 'transaction was' : 'transactions were'} deleted.
          </p>
          <div className="actions">
            <button type="button" className="btn primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
      <div className="stack">
        <p>
          This deletes the copy of <strong>{rec.fileName}</strong> that Flujo kept on this computer. Your original file elsewhere is not touched.
        </p>
        <fieldset className="field">
          <legend>Also delete the transactions imported from this file?</legend>
          <label className="check">
            <input type="radio" name="alsotx" checked={!alsoTx} onChange={() => setAlsoTx(false)} /> No, keep the transactions
          </label>
          <label className="check">
            <input type="radio" name="alsotx" checked={alsoTx} onChange={() => setAlsoTx(true)} /> Yes, delete the transactions imported from this file too
          </label>
        </fieldset>
        <ErrorText message={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => void run()}>
            {alsoTx ? 'Delete file and transactions' : 'Delete file only'}
          </button>
        </div>
      </div>
      )}
    </Dialog>
  )
}
