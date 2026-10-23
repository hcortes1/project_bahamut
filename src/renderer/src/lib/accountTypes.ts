import type { Account } from '@shared/db-types'

export const ACCOUNT_TYPES: { value: Account['type']; label: string }[] = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'credit_card', label: 'Credit card' }
]

export const accountTypeLabel = (t: Account['type']): string => ACCOUNT_TYPES.find((a) => a.value === t)?.label ?? t
