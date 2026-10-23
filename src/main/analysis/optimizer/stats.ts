/** Small robust-statistics helpers over plain numbers. */

export function sum(v: readonly number[]): number {
  let t = 0
  for (const x of v) t += x
  return t
}

export function mean(v: readonly number[]): number {
  return v.length === 0 ? 0 : sum(v) / v.length
}

export function median(v: readonly number[]): number {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}

/** Linear-interpolated quantile, q in [0,1]. */
export function quantile(v: readonly number[], q: number): number {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = s[lo] as number
  const b = s[hi] as number
  return a + (b - a) * (pos - lo)
}

/** Median absolute deviation, scaled to be comparable to a standard deviation. */
export function scaledMad(v: readonly number[]): number {
  const med = median(v)
  return 1.4826 * median(v.map((x) => Math.abs(x - med)))
}

/** Robust z-score; the scale falls back to `floor` when the MAD is (near) zero. */
export function robustZ(x: number, v: readonly number[], floor: number): number {
  const scale = Math.max(scaledMad(v), floor, 1e-9)
  return (x - median(v)) / scale
}

export const roundCents = (x: number): number => Math.round(x)
