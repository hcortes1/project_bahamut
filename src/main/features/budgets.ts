/**
 * Budget progress: spent vs budget per category for one month.
 *
 * Spent comes from spendingByCategory (repos.ts aggregates): live rows on live
 * accounts, transfers excluded, expense magnitude of amount < 0 rows only
 * (refunds/positive rows do not reduce "spent").
 */
import { z } from 'zod'
import { daysBetween, daysInMonth } from '@shared/dates'
import type { Db } from '../db/connection'
import { listBudgets, listCategories, spendingByCategory } from '../db/repos'
import { ValidDate, ValidMonth, firstOfMonth, lastOfMonth, monthOf } from './common'

export type MonthPhase = 'past' | 'current' | 'future'

export interface BudgetProgressItem {
  categoryId: string
  categoryName: string
  budgetCents: number
  spentCents: number
  /** budget - spent; negative when over budget. */
  remainingCents: number
  /** Whole percent of budget used (floor); null when the budget is 0. */
  percentUsed: number | null
  overBudget: boolean
  /** Current month only: budget * elapsedDays / daysInMonth (floor). */
  expectedByNowCents: number | null
  /** Current month only: spent already exceeds the pro-rata amount. */
  overPace: boolean | null
}

export interface BudgetProgress {
  month: string
  phase: MonthPhase
  /** True while the month is still in progress (spent figures are partial). */
  partial: boolean
  /** Human label, e.g. "Month to date (through 2026-10-22)". */
  label: string
  elapsedDays: number
  daysInMonth: number
  items: BudgetProgressItem[]
  totalBudgetCents: number
  totalSpentCents: number
  /** Spending in categories that have no budget this month. */
  unbudgeted: { categoryId: string | null; categoryName: string; spentCents: number }[]
}

const Query = z.object({ month: ValidMonth, today: ValidDate })

export function budgetProgress(db: Db, query: z.input<typeof Query>): BudgetProgress {
  const { month, today } = Query.parse(query)
  const days = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))
  const cur = monthOf(today)
  const phase: MonthPhase = month < cur ? 'past' : month > cur ? 'future' : 'current'
  const elapsed = phase === 'past' ? days : phase === 'future' ? 0 : daysBetween(firstOfMonth(month), today) + 1

  const spendRows = spendingByCategory(db, { from: firstOfMonth(month), to: lastOfMonth(month) })
  const spentBy = new Map(spendRows.map((r) => [r.categoryId, r.expenseCents]))
  const names = new Map(listCategories(db).map((c) => [c.id, c.name]))

  const budgets = listBudgets(db, month)
  const items: BudgetProgressItem[] = budgets
    .map((b) => {
      const spent = spentBy.get(b.categoryId) ?? 0
      return {
        categoryId: b.categoryId,
        categoryName: names.get(b.categoryId) ?? 'Unknown',
        budgetCents: b.amountCents,
        spentCents: spent,
        remainingCents: b.amountCents - spent,
        percentUsed: b.amountCents > 0 ? Math.floor((spent * 100) / b.amountCents) : null,
        overBudget: spent > b.amountCents,
        expectedByNowCents: phase === 'current' ? Math.floor((b.amountCents * elapsed) / days) : null,
        overPace: phase === 'current' ? spent > Math.floor((b.amountCents * elapsed) / days) : null
      }
    })
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName))

  const budgeted = new Set(budgets.map((b) => b.categoryId))
  const unbudgeted = spendRows
    .filter((r) => r.categoryId === null || !budgeted.has(r.categoryId))
    .map((r) => ({ categoryId: r.categoryId, categoryName: r.categoryName, spentCents: r.expenseCents }))

  const label =
    phase === 'current'
      ? `Month to date (through ${today})`
      : phase === 'future'
        ? 'Upcoming month'
        : 'Full month'
  return {
    month,
    phase,
    partial: phase === 'current',
    label,
    elapsedDays: elapsed,
    daysInMonth: days,
    items,
    totalBudgetCents: items.reduce((s, i) => s + i.budgetCents, 0),
    totalSpentCents: items.reduce((s, i) => s + i.spentCents, 0),
    unbudgeted
  }
}
