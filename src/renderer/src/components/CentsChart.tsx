import { useEffect, useRef, useState } from 'react'
import { BarController, BarElement, CategoryScale, Chart, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js'
import { formatCents, formatTick } from '../lib/format'

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend)

export interface Series {
  label: string
  /** Integer cents. */
  data: number[]
  /** Overlay this series as a dashed line on a bar chart (shape, not just color, tells it apart). */
  asLine?: boolean
}

const COLORS = ['--primary', '--series-2', '--series-3']
const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Bar or line chart of cent values. Values stay integer cents; axis and tooltip text is formatted from cents. */
export function CentsChart({ type, labels, series, ariaLabel }: { type: 'bar' | 'line'; labels: string[]; series: Series[]; ariaLabel: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [theme, setTheme] = useState(0)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const bump = () => setTheme((t) => t + 1)
    mq.addEventListener('change', bump)
    return () => mq.removeEventListener('change', bump)
  }, [])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const text = css('--on-surface-variant')
    const grid = css('--outline-variant')
    const chart = new Chart(el, {
      data: {
        labels,
        datasets: series.map((s, i) => {
          const color = css(COLORS[i % COLORS.length] ?? '--primary')
          const line = type === 'line' || s.asLine
          return {
            type: line ? ('line' as const) : ('bar' as const),
            label: s.label,
            data: s.data,
            borderColor: color,
            backgroundColor: color,
            // Second and later bar series get an outline so they differ by more than color.
            ...(!line && i > 0 ? { borderColor: text, borderWidth: 2 } : {}),
            ...(line ? { pointRadius: 3, tension: 0, borderDash: i > 0 ? [6, 4] : [], borderWidth: 2 } : {})
          }
        })
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: series.length > 1, labels: { color: text } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label ?? ''}: ${formatCents(Number(c.parsed.y))}` } }
        },
        scales: {
          x: { ticks: { color: text, maxRotation: 0, autoSkip: true }, grid: { color: grid } },
          y: { ticks: { color: text, precision: 0, callback: (v) => formatTick(Number(v)) }, grid: { color: grid } }
        }
      }
    })
    return () => chart.destroy()
  }, [type, labels, series, theme])

  return (
    <div className="chart-box">
      <canvas ref={canvas} role="img" aria-label={ariaLabel} />
    </div>
  )
}
