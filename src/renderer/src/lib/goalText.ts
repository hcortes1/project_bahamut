import type { GoalProjectionDto } from '@shared/ipc'
import { formatCents } from './format'

export function projectionText(p: GoalProjectionDto): string {
  switch (p.status) {
    case 'achieved':
      return 'Goal reached.'
    case 'projected': {
      const base = `At about ${formatCents(p.monthlyRateCents)} a month, projected to finish ${p.projectedDate}.`
      if (p.onTrack === true) return `${base} On track for the target date.`
      if (p.onTrack === false && p.requiredMonthlyCents !== null) return `${base} To hit the target date you need about ${formatCents(p.requiredMonthlyCents)} a month.`
      return base
    }
    case 'no_progress':
      return 'No net progress recently, so no completion date can be projected.'
    case 'too_far':
      return 'At the current rate this goal is too far away to project.'
    default:
      return 'Add contributions over a few weeks to see a projected completion date.'
  }
}
