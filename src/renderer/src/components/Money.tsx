import { formatCents } from '../lib/format'
import { Icon } from './Icon'

/** Signed amount with an icon and a hidden label, so direction is never conveyed by color alone. */
export function Amount({ cents }: { cents: number }) {
  if (cents === 0) return <span className="num">{formatCents(0)}</span>
  const out = cents < 0
  return (
    <span className={`amount ${out ? 'neg' : 'pos'} num`}>
      <Icon name={out ? 'arrowDown' : 'arrowUp'} size={14} />
      <span className="sr-only">{out ? 'Expense ' : 'Income '}</span>
      {formatCents(cents)}
    </span>
  )
}

/** Horizontal progress bar with a text label provided by the caller. */
export function Bar({ percent, over, label }: { percent: number; over?: boolean; label: string }) {
  return (
    <div className={over ? 'bar over' : 'bar'} role="img" aria-label={label}>
      <div style={{ width: `${percent}%` }} />
    </div>
  )
}
