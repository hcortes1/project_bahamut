/**
 * CSV export of transactions and summaries for a date range.
 *
 * Text cells are RFC 4180 quoted when they contain a comma, quote, CR or LF
 * (quotes doubled) and are neutralised against spreadsheet formula injection:
 * a text cell whose first character is = + - @ (or TAB/CR) gets a leading
 * apostrophe. Money cells are formatted from integer cents with string math
 * only (no floats) and are never prefixed, so negatives stay numeric.
 * Lines end with CRLF.
 */
import { z } from 'zod'
import { formatCents, sumCents } from '@shared/money'
import type { Db } from '../db/connection'
import { listExportTransactions } from '../db/features-repo'
import { incomeVsExpensesByMonth, spendingByCategory } from '../db/repos'
import { FeatureError, Id, ValidDate } from './common'

export interface RawCell {
  raw: string
}
export type CsvCell = string | RawCell

const FORMULA_START = /^[=+\-@\t\r]/

/** Escape one text cell (formula guard + quoting). */
export function csvText(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}
/** Escape a trusted non-text cell (numbers, dates): quoting only, no formula guard. */
export function csvRaw(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}
export const money = (cents: number): RawCell => ({ raw: formatCents(cents, { symbol: false, grouping: false }) })

export function toCsv(rows: CsvCell[][]): string {
  return rows
    .map((r) => r.map((c) => (typeof c === 'string' ? csvText(c) : csvRaw(c.raw))).join(','))
    .join('\r\n')
    .concat(rows.length ? '\r\n' : '')
}

const Range = z
  .object({ from: ValidDate, to: ValidDate, accountId: Id.optional() })
  .refine((r) => r.from <= r.to, { message: 'from must be on or before to' })

/**
 * All live transactions in [from, to] (transfers included, flagged in the
 * Transfer column). Columns: Date, Account, Description, Merchant, Category,
 * Amount, Transfer, Source.
 */
export function exportTransactionsCsv(db: Db, range: z.input<typeof Range>): string {
  const r = parseRange(range)
  const rows = listExportTransactions(db, r.from, r.to, r.accountId)
  return toCsv([
    ['Date', 'Account', 'Description', 'Merchant', 'Category', 'Amount', 'Transfer', 'Source'],
    ...rows.map((t): CsvCell[] => [
      { raw: t.date },
      t.accountName,
      t.description,
      t.merchant ?? '',
      t.categoryName ?? '',
      money(t.amountCents),
      t.isTransfer ? 'yes' : 'no',
      t.source
    ])
  ])
}

/**
 * Summary CSV (transfers excluded, same aggregates as the dashboard).
 * Columns: Section, Name, Income, Expenses, Net. Sections: Month rows, a Total
 * row, then Category rows (expenses only).
 */
export function exportSummaryCsv(db: Db, range: z.input<typeof Range>): string {
  const r = parseRange(range)
  const months = incomeVsExpensesByMonth(db, r)
  const cats = spendingByCategory(db, r)
  const out: CsvCell[][] = [['Section', 'Name', 'Income', 'Expenses', 'Net']]
  for (const m of months) {
    out.push(['Month', { raw: m.month }, money(m.incomeCents), money(m.expenseCents), money(m.incomeCents - m.expenseCents)])
  }
  const inc = sumCents(months.map((m) => m.incomeCents))
  const exp = sumCents(months.map((m) => m.expenseCents))
  out.push(['Total', 'All', money(inc), money(exp), money(inc - exp)])
  for (const c of cats) out.push(['Category', c.categoryName, money(0), money(c.expenseCents), money(-c.expenseCents)])
  return toCsv(out)
}

function parseRange(range: z.input<typeof Range>): z.infer<typeof Range> {
  const res = Range.safeParse(range)
  if (!res.success) throw new FeatureError('INVALID_RANGE', res.error.message)
  return res.data
}
