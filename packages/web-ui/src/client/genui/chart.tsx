/**
 * `chart` surface: bar / line / pie charts hand-rolled as inline SVG.
 *
 * Data projection only — no chart library (the client bundle's externals are
 * react + dsh platform modules), no network, no code execution (SR-02).
 * Malformed shapes throw, degrading to the toolview's static fallback.
 */
import type { CSSProperties, ReactNode } from 'react'
import { asArray, asRecord, asString, formatNumber, optionalString, truncate } from './guards.ts'
import type { UiSurfaceProps } from './registry.ts'

/** Fixed categorical palette (Okabe-Ito-adjacent, readable on light and dark). */
const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7']

/** Inline cap before an ellipsis note — wide plots get unreadable past this. */
const MAX_ITEMS = 12

interface ChartSpec {
  chartType: 'bar' | 'line' | 'pie'
  xKey: string
  series: ReadonlyArray<{ key: string, label: string }>
}

/** Validate the instruction's props/data against the chart contract; throw on mismatch. */
function parseChart({ instruction }: UiSurfaceProps): { spec: ChartSpec, items: ReadonlyArray<Record<string, unknown>> } {
  const p = asRecord(instruction.props)
  const chartType = asString(p.chartType)
  if (chartType !== 'bar' && chartType !== 'line' && chartType !== 'pie') throw new TypeError('chartType must be bar | line | pie')
  const xKey = asString(p.xKey)
  const series = asArray(p.series).map((entry) => {
    const record = asRecord(entry)
    const key = asString(record.key)
    return { key, label: optionalString(record.label) ?? key }
  })
  if (series.length === 0) throw new TypeError('series must be non-empty')
  const items = asArray(asRecord(instruction.data).items).map(asRecord)
  if (items.length === 0) throw new TypeError('data.items must be non-empty')
  return { spec: { chartType, xKey, series }, items }
}

/** Category label of one row: the xKey value, falling back to the row index. */
function labelOf(item: Record<string, unknown>, xKey: string, index: number): string {
  const value = item[xKey]
  return typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : `#${index + 1}`
}

/** Numeric value of one row/series cell; non-finite or missing reads as 0 (lenient holes). */
function valueOf(item: Record<string, unknown>, key: string): number {
  const value = item[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Round a max up to a 1/2/5×10^n ceiling for axis ticks. */
function niceMax(max: number): number {
  if (max <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  const fraction = max / power
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return nice * power
}

/** Axis/label text fill. */
const axisText: CSSProperties = { fill: 'var(--dsw-alias-label-tertiary)', fontSize: 10 }

/** Legend row: one dot + label per series. */
function Legend({ spec }: { spec: ChartSpec }): ReactNode {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '4px 14px', marginTop: 2 }}>
      {spec.series.map((entry, index) => (
        <span key={entry.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: PALETTE[index % PALETTE.length], flex: 'none' }} />
          {entry.label}
        </span>
      ))}
    </div>
  )
}

/** Grouped bar chart over the item rows. */
function BarChart({ spec, items }: { spec: ChartSpec, items: ReadonlyArray<Record<string, unknown>> }): ReactNode {
  const W = 520
  const H = 240
  const padL = 48
  const padR = 12
  const padT = 14
  const padB = 30
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const n = items.length
  const m = spec.series.length
  const max = niceMax(Math.max(0, ...items.flatMap((item) => spec.series.map((entry) => valueOf(item, entry.key)))))
  const band = plotW / n
  const barW = Math.min((band / m) * 0.7, 28)
  const y = (v: number): number => padT + plotH * (1 - v / max)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      {[0, 1, 2, 3, 4].map((tick) => {
        const value = (max * tick) / 4
        const yy = y(value)
        return (
          <g key={tick}>
            <line x1={padL} x2={W - padR} y1={yy} y2={yy} style={{ stroke: 'var(--dsw-specific-input-major)', strokeWidth: 1 }} />
            <text x={padL - 6} y={yy + 3} textAnchor="end" style={axisText}>{formatNumber(value)}</text>
          </g>
        )
      })}
      {items.map((item, i) => (
        <g key={i}>
          {spec.series.map((entry, j) => {
            const value = valueOf(item, entry.key)
            const x = padL + band * i + (band - barW * m) / 2 + j * barW
            const height = Math.max(0, plotH * (value / max))
            return (
              <rect key={entry.key} data-hg-mark="" x={x} y={y(value)} width={barW} height={height} fill={PALETTE[j % PALETTE.length]}>
                <title>{`${entry.label} · ${labelOf(item, spec.xKey, i)}: ${formatNumber(value)}`}</title>
              </rect>
            )
          })}
          <text x={padL + band * (i + 0.5)} y={H - 10} textAnchor="middle" style={axisText}>
            {truncate(labelOf(item, spec.xKey, i), 8)}
          </text>
        </g>
      ))}
    </svg>
  )
}

/** Multi-series line chart with point markers. */
function LineChart({ spec, items }: { spec: ChartSpec, items: ReadonlyArray<Record<string, unknown>> }): ReactNode {
  const W = 520
  const H = 240
  const padL = 48
  const padR = 12
  const padT = 14
  const padB = 30
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const n = items.length
  const max = niceMax(Math.max(0, ...items.flatMap((item) => spec.series.map((entry) => valueOf(item, entry.key)))))
  const band = plotW / Math.max(1, n)
  const y = (v: number): number => padT + plotH * (1 - v / max)
  const x = (i: number): number => padL + band * (i + 0.5)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      {[0, 1, 2, 3, 4].map((tick) => {
        const value = (max * tick) / 4
        const yy = y(value)
        return (
          <g key={tick}>
            <line x1={padL} x2={W - padR} y1={yy} y2={yy} style={{ stroke: 'var(--dsw-specific-input-major)', strokeWidth: 1 }} />
            <text x={padL - 6} y={yy + 3} textAnchor="end" style={axisText}>{formatNumber(value)}</text>
          </g>
        )
      })}
      {items.map((item, i) => (
        <text key={i} x={x(i)} y={H - 10} textAnchor="middle" style={axisText}>
          {truncate(labelOf(item, spec.xKey, i), 8)}
        </text>
      ))}
      {spec.series.map((entry, j) => {
        const points = items.map((item, i) => `${x(i)},${y(valueOf(item, entry.key))}`).join(' ')
        return (
          <g key={entry.key}>
            <polyline points={points} fill="none" stroke={PALETTE[j % PALETTE.length]} strokeWidth={2} strokeLinejoin="round" />
            {items.map((item, i) => {
              const value = valueOf(item, entry.key)
              return (
                <circle key={i} data-hg-mark="" cx={x(i)} cy={y(value)} r={3} fill={PALETTE[j % PALETTE.length]}>
                  <title>{`${entry.label} · ${labelOf(item, spec.xKey, i)}: ${formatNumber(value)}`}</title>
                </circle>
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

/** Pie over the first series, with an inline legend and percentage labels. */
function PieChart({ spec, items }: { spec: ChartSpec, items: ReadonlyArray<Record<string, unknown>> }): ReactNode {
  const entry = spec.series[0]
  const rows = items.map((item, i) => ({ label: labelOf(item, spec.xKey, i), value: valueOf(item, entry.key) }))
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  const cx = 120
  const cy = 115
  const r = 95
  let angle = -Math.PI / 2
  const slices = rows.map((row, i) => {
    const sweep = total > 0 ? (row.value / total) * Math.PI * 2 : 0
    const start = angle
    const end = angle + sweep
    angle = end
    const large = sweep > Math.PI ? 1 : 0
    const p1 = [cx + r * Math.cos(start), cy + r * Math.sin(start)]
    const p2 = [cx + r * Math.cos(end), cy + r * Math.sin(end)]
    const mid = (start + end) / 2
    return {
      ...row,
      index: i,
      path: `M ${cx} ${cy} L ${p1[0]} ${p1[1]} A ${r} ${r} 0 ${large} 1 ${p2[0]} ${p2[1]} Z`,
      pct: total > 0 ? row.value / total : 0,
      labelX: cx + r * 0.62 * Math.cos(mid),
      labelY: cy + r * 0.62 * Math.sin(mid),
    }
  })
  return (
    <div>
      <svg viewBox="0 0 520 240" style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
        {total > 0
          ? slices.map((slice) => (
            <g key={slice.index}>
              <path d={slice.path} data-hg-mark="" fill={PALETTE[slice.index % PALETTE.length]} stroke="var(--dsw-specific-input-major)" strokeWidth={1}>
                <title>{`${entry.label} · ${slice.label}: ${formatNumber(slice.value)} (${Math.round(slice.pct * 100)}%)`}</title>
              </path>
              {slice.pct >= 0.05 && (
                <text x={slice.labelX} y={slice.labelY + 3} textAnchor="middle" style={{ fill: '#fff', fontSize: 10, fontWeight: 600 }}>
                  {Math.round(slice.pct * 100)}%
                </text>
              )}
            </g>
          ))
          : (
            <text x={cx} y={cy} textAnchor="middle" style={axisText}>无可视化数据</text>
          )}
        {slices.slice(0, 16).map((slice) => (
          <g key={`legend-${slice.index}`}>
            <rect x={250} y={24 + slice.index * 13} width={9} height={9} fill={PALETTE[slice.index % PALETTE.length]} />
            <text x={264} y={31 + slice.index * 13} style={axisText}>
              {truncate(`${slice.label} · ${formatNumber(slice.value)}`, 30)}
            </text>
          </g>
        ))}
      </svg>
      {rows.length > 16 && <p style={{ margin: 0, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>仅显示前 16 项（共 {rows.length} 项）</p>}
    </div>
  )
}

/** The registered `chart` surface. */
export function ChartSurface(props: UiSurfaceProps): ReactNode {
  const { spec, items } = parseChart(props)
  const shown = items.slice(0, MAX_ITEMS)
  return (
    <div className="hg-chart" style={{ display: 'grid', gap: 4 }}>
      {spec.chartType === 'bar' && <BarChart spec={spec} items={shown} />}
      {spec.chartType === 'line' && <LineChart spec={spec} items={shown} />}
      {spec.chartType === 'pie' && <PieChart spec={spec} items={shown} />}
      <Legend spec={spec} />
      {items.length > MAX_ITEMS && spec.chartType !== 'pie' && (
        <p style={{ margin: 0, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>仅显示前 {MAX_ITEMS} 项（共 {items.length} 项）</p>
      )}
    </div>
  )
}
