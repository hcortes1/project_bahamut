import { useId } from 'react'

export interface CredentialValues {
  pin: string
  password: string
}
export const emptyCredentials: CredentialValues = { pin: '', password: '' }

/** Build the request object from only the credentials that are enabled. */
export function toCredentials(v: CredentialValues, pinEnabled: boolean, passwordEnabled: boolean) {
  return { ...(pinEnabled ? { pin: v.pin } : {}), ...(passwordEnabled ? { password: v.password } : {}) }
}

/** True when every enabled credential has some text. */
export const credentialsFilled = (v: CredentialValues, pinEnabled: boolean, passwordEnabled: boolean): boolean =>
  (!pinEnabled || v.pin !== '') && (!passwordEnabled || v.password !== '') && (pinEnabled || passwordEnabled)

/** PIN and/or password inputs for the credentials that are set up. When both are set, both are required. */
export function CredentialInputs({
  value,
  onChange,
  pinEnabled,
  passwordEnabled,
  disabled,
  autoFocus
}: {
  value: CredentialValues
  onChange: (v: CredentialValues) => void
  pinEnabled: boolean
  passwordEnabled: boolean
  disabled?: boolean
  autoFocus?: boolean
}) {
  const pinId = useId()
  const pwId = useId()
  return (
    <>
      {pinEnabled && (
        <div className="field">
          <label htmlFor={pinId}>PIN</label>
          <input
            id={pinId}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={value.pin}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(e) => onChange({ ...value, pin: e.target.value.replace(/\D/g, '') })}
          />
        </div>
      )}
      {passwordEnabled && (
        <div className="field">
          <label htmlFor={pwId}>Password</label>
          <input
            id={pwId}
            type="password"
            autoComplete="off"
            value={value.password}
            disabled={disabled}
            autoFocus={autoFocus && !pinEnabled}
            onChange={(e) => onChange({ ...value, password: e.target.value })}
          />
        </div>
      )}
    </>
  )
}
