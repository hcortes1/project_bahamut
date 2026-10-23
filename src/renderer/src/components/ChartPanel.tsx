import { useId, useState } from 'react'
import { formatCents } from '../lib/format'
import { CentsChart, type Series } from './CentsChart'

/** A chart with a "Show as table" toggle. The table carries the same numbers as the chart. */
export function ChartPanel({
  title,
  type,
  labels,
  series,
  rowHeader,
  summary
}: {
  title: string
  type: 'bar' | 'line'
  labels: string[]
  series: Series[]
  rowHeader: string
  summary: string
}) {
  const [asTable, setAsTable] = useState(false)
  const id = useId()
  return (
    <section className="card tight" aria-labelledby={id}>
      <div className="row-between">
        <h2 id={id} className="h-sm">
          {title}
        </h2>
        <button type="button" className="btn small" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>
          {asTable ? 'Show chart' : 'Show as table'}
        </button>
      </div>
      {labels.length === 0 ? (
        <p className="muted">No data in this range.</p>
      ) : asTable ? (
        <div className="table-wrap tall">
          <table>
            <caption className="sr-only">{summary}</caption>
            <thead>
              <tr>
                <th scope="col">{rowHeader}</th>
                {series.map((s) => (
                  <th key={s.label} scope="col" className="right">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={l}>
                  <th scope="row">{l}</th>
                  {series.map((s) => (
                    <td key={s.label} className="right num">
                      {formatCents(s.data[i] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <CentsChart type={type} labels={labels} series={series} ariaLabel={summary} />
      )}
    </section>
  )
}
