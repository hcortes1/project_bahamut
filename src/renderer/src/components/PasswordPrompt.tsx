import { useState, type FormEvent } from 'react'
import type { PasswordPromptEvent } from '@shared/ipc'
import { errorMessage, unwrap } from '../lib/api'
import { flujo } from '../lib/flujo'
import { Dialog, ErrorText } from './ui'

/** Asks for a PDF password. Cancel (or Esc) answers null, which cancels the import. */
export function PasswordPrompt({ prompt, onDone }: { prompt: PasswordPromptEvent; onDone: () => void }) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)

  const answer = async (password: string | null) => {
    try {
      await unwrap(flujo().imports.providePassword({ promptId: prompt.promptId, password }))
      setPw('')
      onDone()
    } catch (err) {
      setError(errorMessage(err))
      onDone()
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (pw !== '') void answer(pw)
  }

  return (
    <Dialog title="Password needed" onClose={() => void answer(null)}>
      <form onSubmit={submit} className="stack">
        <p>
          <strong>{prompt.fileName}</strong> is protected. Enter its password to read it. The password is used once and not saved.
        </p>
        {prompt.reason === 'PASSWORD_INCORRECT' && (
          <p className="status bad" role="alert">
            That password was incorrect (attempt {prompt.attempt}). Try again.
          </p>
        )}
        <div className="field">
          <label htmlFor="pdf-pw">PDF password</label>
          <input id="pdf-pw" type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        <ErrorText message={error} />
        <div className="actions">
          <button type="button" className="btn" onClick={() => void answer(null)}>
            Cancel import
          </button>
          <button type="submit" className="btn primary" disabled={pw === ''}>
            Open file
          </button>
        </div>
      </form>
    </Dialog>
  )
}
