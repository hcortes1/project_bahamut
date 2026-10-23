/**
 * Savings goals and contributions.
 *
 * savings_goals.current_cents is ALWAYS the sum of the goal's live
 * contributions, recomputed after every contribution change. An opening
 * balance is therefore recorded as a first contribution. Negative
 * contributions (withdrawals) are allowed.
 */
import { z } from 'zod'
import { addDays, daysBetween } from '@shared/dates'
import type { Db } from '../db/connection'
import {
  getContributionRow,
  getGoalRow,
  insertContributionRow,
  insertGoalRow,
  listContributionRows,
  listGoalRows,
  recomputeGoalCurrent,
  softDeleteGoalContributions,
  softDeleteRow,
  updateContributionRow,
  updateGoalRow,
  type ContributionRow,
  type GoalRow
} from '../db/features-repo'
import { FeatureError, Id, NonZeroCents, PositiveCents, ValidDate } from './common'

export type SavingsGoal = GoalRow
export type GoalContribution = ContributionRow

export const NewGoal = z.object({
  name: z.string().trim().min(1).max(200),
  targetCents: PositiveCents,
  targetDate: ValidDate.nullable().default(null),
  /** Optional opening balance, stored as a contribution dated `openingDate`. */
  openingCents: z.number().int().min(0).max(1_000_000_000_000).default(0),
  openingDate: ValidDate.optional()
})
export type NewGoalInput = z.input<typeof NewGoal>
export const GoalPatch = z
  .object({ name: NewGoal.shape.name, targetCents: PositiveCents, targetDate: ValidDate.nullable() })
  .partial()

export function createGoal(db: Db, input: NewGoalInput): SavingsGoal {
  const v = NewGoal.parse(input)
  if (v.openingCents > 0 && !v.openingDate) throw new FeatureError('OPENING_DATE_REQUIRED')
  return db.transaction(() => {
    const id = insertGoalRow(db, { name: v.name, targetCents: v.targetCents, targetDate: v.targetDate })
    if (v.openingCents > 0 && v.openingDate) {
      insertContributionRow(db, id, v.openingDate, v.openingCents)
      recomputeGoalCurrent(db, id)
    }
    return getGoalRow(db, id) as SavingsGoal
  })()
}
export const getGoal = (db: Db, id: string): SavingsGoal | undefined => getGoalRow(db, id)
export const listGoals = (db: Db): SavingsGoal[] => listGoalRows(db)

export function updateGoal(db: Db, id: string, patch: z.input<typeof GoalPatch>): SavingsGoal | undefined {
  const cur = getGoalRow(db, id)
  if (!cur) return undefined
  const p = GoalPatch.parse(patch)
  updateGoalRow(db, id, {
    name: p.name ?? cur.name,
    targetCents: p.targetCents ?? cur.targetCents,
    targetDate: p.targetDate === undefined ? cur.targetDate : p.targetDate
  })
  return getGoalRow(db, id)
}
export function deleteGoal(db: Db, id: string): boolean {
  return db.transaction(() => {
    softDeleteGoalContributions(db, id)
    return softDeleteRow(db, 'savings_goals', id)
  })()
}

// --------------------------------------------------------- contributions
export const NewContribution = z.object({ goalId: Id, date: ValidDate, amountCents: NonZeroCents })
export type NewContributionInput = z.input<typeof NewContribution>

export function addContribution(db: Db, input: NewContributionInput): GoalContribution {
  const v = NewContribution.parse(input)
  if (!getGoalRow(db, v.goalId)) throw new FeatureError('GOAL_NOT_FOUND')
  return db.transaction(() => {
    const id = insertContributionRow(db, v.goalId, v.date, v.amountCents)
    recomputeGoalCurrent(db, v.goalId)
    return getContributionRow(db, id) as GoalContribution
  })()
}
export const listContributions = (db: Db, goalId: string): GoalContribution[] =>
  listContributionRows(db, goalId)

export function updateContribution(
  db: Db,
  id: string,
  patch: { date?: string; amountCents?: number }
): GoalContribution | undefined {
  const cur = getContributionRow(db, id)
  if (!cur) return undefined
  const p = z.object({ date: ValidDate, amountCents: NonZeroCents }).partial().parse(patch)
  return db.transaction(() => {
    updateContributionRow(db, id, p.date ?? cur.date, p.amountCents ?? cur.amountCents)
    recomputeGoalCurrent(db, cur.goalId)
    return getContributionRow(db, id)
  })()
}
export function deleteContribution(db: Db, id: string): boolean {
  return db.transaction(() => {
    const cur = getContributionRow(db, id)
    if (!cur) return false
    const ok = softDeleteRow(db, 'goal_contributions', id)
    recomputeGoalCurrent(db, cur.goalId)
    return ok
  })()
}

// ------------------------------------------------------------ projection
/** Contribution-rate look-back window, days. */
export const PROJECTION_WINDOW_DAYS = 180
/** The rate window never shrinks below this, so one lump sum is not read as a daily rate. */
export const PROJECTION_MIN_WINDOW_DAYS = 30
/** Projections further out than this are reported as 'too_far'. */
export const PROJECTION_MAX_DAYS = 365 * 100

export type ProjectionStatus =
  | 'achieved' // current >= target
  | 'projected' // projectedDate is set
  | 'insufficient_data' // fewer than 2 contributions in the window
  | 'no_progress' // net contributions in the window are zero or negative
  | 'too_far' // more than 100 years out

export interface GoalProjection {
  goalId: string
  status: ProjectionStatus
  remainingCents: number
  /** Net contributions inside the rate window (integer cents). */
  windowNetCents: number
  windowDays: number
  /** Average net contribution per 30 days, rounded down (cents); 0 when unknown. */
  monthlyRateCents: number
  projectedDate: string | null
  /** Only when the goal has a target date and is not achieved. */
  targetDate: string | null
  onTrack: boolean | null
  /** Cents/30 days needed to reach the target by targetDate (ceil); null without a future target date. */
  requiredMonthlyCents: number | null
}

/**
 * Projected completion from the recent contribution rate.
 *
 * rate window: [max(firstContribution, today-179), today]. windowDays =
 * max(30, days in that span). Contributions dated after `today` are ignored.
 * Net contributions N in the window give rate N/windowDays per day; the
 * projection is today + ceil(remaining * windowDays / N). Irregular
 * contributions are smoothed by dividing by the whole window, not by the gaps.
 * Needs at least 2 contributions in the window; N <= 0 means no progress.
 * All arithmetic is integer (amounts are capped so products stay < 2^53).
 */
export function projectGoal(db: Db, goalId: string, today: string): GoalProjection {
  const t = ValidDate.parse(today)
  const goal = getGoalRow(db, goalId)
  if (!goal) throw new FeatureError('GOAL_NOT_FOUND')
  const contribs = listContributionRows(db, goalId).filter((c) => c.date <= t)
  // Saved so far as of today (future-dated contributions are not counted yet).
  const remaining = goal.targetCents - contribs.reduce((s, c) => s + c.amountCents, 0)
  const first = contribs[0]
  const windowStart = first ? maxIso(first.date, addDays(t, -(PROJECTION_WINDOW_DAYS - 1))) : t
  const inWindow = contribs.filter((c) => c.date >= windowStart)
  const windowDays = Math.max(PROJECTION_MIN_WINDOW_DAYS, daysBetween(windowStart, t) + 1)
  const net = inWindow.reduce((s, c) => s + c.amountCents, 0)
  const monthlyRate = net > 0 ? Math.floor((net * 30) / windowDays) : 0

  const base = {
    goalId,
    remainingCents: Math.max(remaining, 0),
    windowNetCents: net,
    windowDays,
    monthlyRateCents: monthlyRate,
    targetDate: goal.targetDate
  }
  const required = requiredMonthly(remaining, goal.targetDate, t)

  if (remaining <= 0) {
    return { ...base, status: 'achieved', projectedDate: null, onTrack: null, requiredMonthlyCents: null }
  }
  const mk = (status: ProjectionStatus, projectedDate: string | null): GoalProjection => ({
    ...base,
    status,
    projectedDate,
    onTrack: goal.targetDate === null ? null : projectedDate !== null && projectedDate <= goal.targetDate,
    requiredMonthlyCents: required
  })
  if (inWindow.length < 2) return mk('insufficient_data', null)
  if (net <= 0) return mk('no_progress', null)
  const days = Math.ceil((remaining * windowDays) / net)
  if (days > PROJECTION_MAX_DAYS) return mk('too_far', null)
  return mk('projected', addDays(t, days))
}

const maxIso = (a: string, b: string): string => (a > b ? a : b)

function requiredMonthly(remaining: number, targetDate: string | null, today: string): number | null {
  if (targetDate === null || remaining <= 0) return null
  const daysLeft = daysBetween(today, targetDate)
  if (daysLeft <= 0) return null
  return Math.ceil((remaining * 30) / daysLeft)
}
