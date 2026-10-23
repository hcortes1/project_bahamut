import type { IncomeExpenseDto, MonthSpendDto, TrendDto } from '@shared/ipc'

const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 2026", or "Oct 2026 (partial)" for the month still in progress. */
export function chartMonthLabel(month: string, partial: boolean): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${NAMES[m - 1]} ${y}${partial ? ' (partial)' : ''}`
}

export function spendingShape(rows: MonthSpendDto[]) {
  return {
    labels: rows.map((r) => chartMonthLabel(r.month, r.partial)),
    series: [{ label: 'Spending', data: rows.map((r) => r.expenseCents) }]
  }
}

export function trendShape(t: TrendDto) {
  return {
    labels: t.points.map((p) => chartMonthLabel(p.month, p.partial)),
    series: [
      { label: 'Spending', data: t.points.map((p) => p.expenseCents) },
      { label: `Trailing ${t.window}-month average`, data: t.points.map((p) => p.trailingAverageCents) }
    ]
  }
}

export function incomeShape(rows: IncomeExpenseDto[]) {
  return {
    labels: rows.map((r) => chartMonthLabel(r.month, r.partial)),
    series: [
      { label: 'Income', data: rows.map((r) => r.incomeCents) },
      { label: 'Expenses', data: rows.map((r) => r.expenseCents) },
      { label: 'Net', data: rows.map((r) => r.netCents), asLine: true }
    ]
  }
}

/** Default dashboard range: the first day of the month 11 months ago through today. */
export function defaultRange(now: Date = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1)
  const p = (n: number) => String(n).padStart(2, '0')
  return {
    from: `${start.getFullYear()}-${p(start.getMonth() + 1)}-01`,
    to: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  }
}
