import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { errorMessage } from '../lib/api'
import { Icon } from './Icon'

/** Error line announced to screen readers. Always rendered so the live region exists before the text. */
export function ErrorText({ message }: { message: string | null }) {
  return (
    <div role="alert" className="error-text">
      {message && (
        <>
          <Icon name="alert" size={16} />
          <span>{message}</span>
        </>
      )}
    </div>
  )
}

/** Modal dialog on the native <dialog>: focus trap, Esc to close and focus return come from the browser. */
export function Dialog({
  title,
  onClose,
  children,
  wide
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
    return () => {
      d?.close()
      // If the element that opened the dialog is gone (e.g. a deleted row), keep focus inside the page.
      if (!document.activeElement || document.activeElement === document.body) document.querySelector<HTMLElement>('main.content')?.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={wide ? 'dialog wide' : 'dialog'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="btn icon" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  )
}

/** Confirmation that names exactly what will be deleted. `typeToConfirm` requires typing that word. */
export function ConfirmDialog({
  title,
  confirmLabel,
  typeToConfirm,
  onConfirm,
  onClose,
  children
}: {
  title: string
  confirmLabel: string
  typeToConfirm?: string
  onConfirm: () => Promise<void>
  onClose: () => void
  children: ReactNode
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const ready = !typeToConfirm || typed === typeToConfirm

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        {children}
        {typeToConfirm && (
          <div className="field">
            <label htmlFor={inputId}>Type {typeToConfirm} to confirm</label>
            <input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
          </div>
        )}
        <ErrorText message={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn danger" disabled={!ready || busy}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** What a full wipe deletes. Shared by Settings and the lock screen so the wording never drifts. */
export function WipeList() {
  return (
    <ul className="plain-list">
      <li>the database, including every account, transaction, budget, goal and setting</li>
      <li>all pre-migration database backups</li>
      <li>all kept statement files (the imports folder)</li>
    </ul>
  )
}
