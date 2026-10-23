import type { IconName } from '../components/Icon'

export type ScreenId = 'dashboard' | 'accounts' | 'transactions' | 'budgets' | 'goals' | 'optimizer' | 'import' | 'settings'

export const SCREENS: { id: ScreenId; label: string; icon: IconName }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'accounts', label: 'Accounts', icon: 'accounts' },
  { id: 'transactions', label: 'Transactions', icon: 'transactions' },
  { id: 'budgets', label: 'Budgets', icon: 'budgets' },
  { id: 'goals', label: 'Goals & Net Worth', icon: 'goals' },
  { id: 'optimizer', label: 'Optimizer', icon: 'optimizer' },
  { id: 'import', label: 'Import', icon: 'import' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]
