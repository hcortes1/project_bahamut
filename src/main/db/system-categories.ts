import type { z } from 'zod'
import type { CategoryKind } from '@shared/db-types'

export const INCOME_CATEGORY_ID = '00000000-0000-4000-8000-000000000001'
export const TRANSFER_CATEGORY_ID = '00000000-0000-4000-8000-000000000002'
export const UNCATEGORIZED_CATEGORY_ID = '00000000-0000-4000-8000-000000000003'

export const SYSTEM_CATEGORIES: { id: string; name: string; kind: z.infer<typeof CategoryKind> }[] = [
  { id: INCOME_CATEGORY_ID, name: 'Income', kind: 'income' },
  { id: TRANSFER_CATEGORY_ID, name: 'Transfer', kind: 'transfer' },
  { id: UNCATEGORIZED_CATEGORY_ID, name: 'Uncategorized', kind: 'expense' },
  ...[
    'Groceries',
    'Dining',
    'Transportation',
    'Housing',
    'Utilities',
    'Healthcare',
    'Entertainment',
    'Shopping',
    'Subscriptions',
    'Travel',
    'Education',
    'Fees',
    'Other'
  ].map((name, i) => ({
    id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
    name,
    kind: 'expense' as const
  }))
]
