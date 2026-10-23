import { useState, type FormEvent } from 'react'
import type { Category } from '@shared/db-types'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { Icon } from './Icon'
import { ConfirmDialog, Dialog, ErrorText } from './ui'

const KINDS: Category['kind'][] = ['expense', 'income', 'transfer']
const KIND_LABEL: Record<Category['kind'], string> = { expense: 'Expense', income: 'Income', transfer: 'Transfer' }

/** Create, rename and delete categories. System categories are read-only. */
export function ManageCategories({ categories, onClose, onChanged }: { categories: Category[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Category['kind']>('expense')
  const [editing, setEditing] = useState<Category | null>(null)
  const [deleting, setDeleting] = useState<Category | null>(null)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() === '') return setError('Enter a category name.')
    setError(null)
    try {
      if (editing) await unwrap(flujo().categories.update({ id: editing.id, patch: { name: name.trim(), kind } }))
      else await unwrap(flujo().categories.create({ name: name.trim(), kind }))
      setName('')
      setEditing(null)
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog title="Categories" onClose={onClose} wide>
      <form onSubmit={save} className="stack">
        <div className="grid-3">
          <div className="field">
            <label htmlFor="cat-name">{editing ? 'Rename category' : 'New category name'}</label>
            <input id="cat-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="cat-kind">Kind</label>
            <select id="cat-kind" value={kind} onChange={(e) => setKind(e.target.value as Category['kind'])}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="actions start align-end">
            <button type="submit" className="btn primary">
              {editing ? 'Save category' : 'Add category'}
            </button>
            {editing && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setEditing(null)
                  setName('')
                }}
              >
                Cancel edit
              </button>
            )}
          </div>
        </div>
        <ErrorText message={error} />
      </form>
      <div className="table-wrap tall">
        <table>
          <caption className="sr-only">Categories</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <th scope="row">{c.name}</th>
                <td>{KIND_LABEL[c.kind]}</td>
                <td className="right nowrap">
                  {c.isSystem ? (
                    <span className="muted">Built in</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn icon"
                        aria-label={`Edit category ${c.name}`}
                        onClick={() => {
                          setEditing(c)
                          setName(c.name)
                          setKind(c.kind)
                        }}
                      >
                        <Icon name="edit" size={16} />
                      </button>
                      <button type="button" className="btn icon" aria-label={`Delete category ${c.name}`} onClick={() => setDeleting(c)}>
                        <Icon name="trash" size={16} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete category"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await unwrap(flujo().categories.delete({ id: deleting.id }))
            setDeleting(null)
            onChanged()
          }}
        >
          <p>This deletes the category {deleting.name}. Its transactions and learned rules move to Uncategorized, its budgets merge into the Uncategorized budget, and its recurring bills lose their category. No transaction is deleted.</p>
        </ConfirmDialog>
      )}
    </Dialog>
  )
}
