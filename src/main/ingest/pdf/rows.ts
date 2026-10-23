import type { Cell, Row, TextItem } from './types'

/**
 * Reconstructs visual rows: items are clustered by y (never by raw stream order), then ordered by x and
 * merged into cells where the horizontal gap is small.
 */
export function buildRows(items: TextItem[], page: number): Row[] {
  const usable = items.filter((i) => i.str.trim() !== '').sort((a, b) => a.y - b.y || a.x - b.x)
  const groups: { y: number; items: TextItem[] }[] = []
  for (const item of usable) {
    const g = groups[groups.length - 1]
    const tol = Math.max(1.5, 0.45 * (item.height || 8))
    if (g && Math.abs(item.y - g.y) <= tol) {
      g.items.push(item)
      g.y = g.items.reduce((s, i) => s + i.y, 0) / g.items.length
    } else {
      groups.push({ y: item.y, items: [item] })
    }
  }
  return groups.map((g) => {
    const sorted = [...g.items].sort((a, b) => a.x - b.x)
    const height = Math.max(...sorted.map((i) => i.height || 8))
    const cells: Cell[] = []
    for (const it of sorted) {
      const last = cells[cells.length - 1]
      if (last && it.x - last.xEnd < 0.6 * height) {
        const gap = it.x - last.xEnd
        last.text += (gap > 0.15 * height ? ' ' : '') + it.str.trim()
        last.xEnd = Math.max(last.xEnd, it.xEnd)
      } else {
        cells.push({ text: it.str.trim(), x: it.x, xEnd: it.xEnd })
      }
    }
    return { page, y: g.y, height, cells, text: cells.map((c) => c.text).join(' ') }
  })
}
