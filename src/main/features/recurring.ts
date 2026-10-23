/** Recurring bills/subscriptions (recurring_items). */
import { z } from 'zod'
import { daysBetween } from '@shared/dates'
import type { Db } from '../db/connection'
import {
  getRecurringRow,
  insertRecurring,
  listRecurringRows,
  softDeleteRow,
  updateRecurringRow,
  type RecurringRow
} from '../db/features-repo'
import { assertLiveCategory } from '../db/repos'
import { addDays, addMonths, FeatureError, Id, SafeCents, ValidDate } from './common'

export const Cadence = z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly'])
export type Cadence = z.infer<typeof Cadence>
export const RecurringStatus = z.enum(['active', 'paused', 'cancelled'])

export const NewRecurring = z.object({
  name: z.string().trim().min(1).max(200),
  amountCents: SafeCents,
  cadence: Cadence,
  nextDue: ValidDate.nullable().default(null),
  categoryId: Id.nullable().default(null),
  /** Linked to a detected subscription (instructions section 9.3). */
  isSubscription: z.boolean().default(false),
  status: RecurringStatus.default('active')
})
export type NewRecurringInput = z.input<typeof NewRecurring>
export const RecurringPatch = NewRecurring.partial()
export type RecurringItem = RecurringRow

export const createRecurring = (db: Db, input: NewRecurringInput): RecurringItem => {
  const v = NewRecurring.parse(input)
  if (v.categoryId) assertLiveCategory(db, v.categoryId)
  return getRecurringRow(db, insertRecurring(db, v)) as RecurringItem
}
export const getRecurring = (db: Db, id: string): RecurringItem | undefined => getRecurringRow(db, id)
export const listRecurring = (db: Db, status?: z.infer<typeof RecurringStatus>): RecurringItem[] =>
  listRecurringRows(db, status === undefined ? undefined : RecurringStatus.parse(status))

export function updateRecurring(
  db: Db,
  id: string,
  patch: z.input<typeof RecurringPatch>
): RecurringItem | undefined {
  const cur = getRecurringRow(db, id)
  if (!cur) return undefined
  const { id: _id, ...rest } = cur
  void _id
  const v = NewRecurring.parse({ ...rest, ...RecurringPatch.parse(patch) })
  if (v.categoryId) assertLiveCategory(db, v.categoryId)
  updateRecurringRow(db, id, v)
  return getRecurringRow(db, id)
}
export const deleteRecurring = (db: Db, id: string): boolean => softDeleteRow(db, 'recurring_items', id)

/** Flag/unflag a recurring item as linked to a detected subscription. */
export const linkSubscription = (db: Db, id: string, isSubscription = true): RecurringItem | undefined =>
  updateRecurring(db, id, { isSubscription })

/**
 * Next due date one cadence after `from`. Monthly-based cadences clamp to month
 * length; pass `anchorDay` (e.g. 31) to avoid drift after a short month.
 */
export function nextDueAfter(from: string, cadence: Cadence, anchorDay?: number): string {
  switch (cadence) {
    case 'weekly':
      return addDays(from, 7)
    case 'biweekly':
      return addDays(from, 14)
    case 'monthly':
      return addMonths(from, 1, anchorDay)
    case 'quarterly':
      return addMonths(from, 3, anchorDay)
    case 'yearly':
      return addMonths(from, 12, anchorDay)
  }
}

/** Mark the current occurrence paid: advance next_due by exactly one cadence. */
export function markRecurringPaid(db: Db, id: string, anchorDay?: number): RecurringItem {
  const cur = getRecurringRow(db, id)
  if (!cur) throw new FeatureError('RECURRING_NOT_FOUND')
  if (cur.status !== 'active') throw new FeatureError('RECURRING_NOT_ACTIVE')
  if (!cur.nextDue) throw new FeatureError('RECURRING_NO_NEXT_DUE')
  const next = nextDueAfter(cur.nextDue, Cadence.parse(cur.cadence), anchorDay)
  return updateRecurring(db, id, { nextDue: next }) as RecurringItem
}

export interface DueItem extends RecurringItem {
  /** Negative when overdue. */
  daysUntilDue: number
  overdue: boolean
}

/** Active items due on or before today + withinDays (overdue included), soonest first. */
export function listDueSoon(db: Db, today: string, withinDays = 7): DueItem[] {
  const t = ValidDate.parse(today)
  const limit = addDays(t, z.number().int().min(0).max(3660).parse(withinDays))
  return listRecurringRows(db, 'active')
    .filter((i): i is RecurringItem & { nextDue: string } => i.nextDue !== null && i.nextDue <= limit)
    .map((i) => {
      const d = daysBetween(t, i.nextDue)
      return { ...i, daysUntilDue: d, overdue: d < 0 }
    })
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue || a.name.localeCompare(b.name))
}
