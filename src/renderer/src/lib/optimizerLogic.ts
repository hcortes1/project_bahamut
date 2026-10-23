import type { AnomalyFlagDto, FlagRecordDto, SubscriptionDto, SubscriptionRecordDto } from '@shared/ipc'

/** Stored status of a detected subscription ('active' when the record is not found). */
export const subscriptionStatus = (sub: SubscriptionDto, records: SubscriptionRecordDto[]): string =>
  records.find((r) => r.id === sub.recordId)?.status ?? sub.status

/** Detected subscriptions the user has not rejected. */
export const visibleSubscriptions = (subs: SubscriptionDto[], records: SubscriptionRecordDto[]): SubscriptionDto[] =>
  subs.filter((s) => subscriptionStatus(s, records) !== 'rejected')

/** Stored status of a flag: open, dismissed or confirmed. */
export const flagStatus = (flag: AnomalyFlagDto, records: FlagRecordDto[]): FlagRecordDto['status'] =>
  records.find((r) => r.id === flag.recordId)?.status ?? 'open'

export const SEVERITY_LABEL: Record<AnomalyFlagDto['severity'], string> = { low: 'Low', medium: 'Medium', high: 'High' }

export const cadenceLabel = (c: SubscriptionDto['cadence']): string => (c === 'annual' ? 'yearly' : c)
