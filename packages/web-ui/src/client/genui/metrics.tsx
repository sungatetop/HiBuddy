/**
 * `metrics` surface: a row of KPI cards.
 *
 * props: { items: [{ key, label, unit? }] }
 * data:  { values: { [key]: number } }
 *
 * Pure number projection; malformed shapes throw into the static fallback.
 */
import type { CSSProperties, ReactNode } from 'react'
import { asArray, asNumber, asRecord, asString, formatNumber, optionalString } from './guards.ts'
import type { UiSurfaceProps } from './registry.ts'

interface MetricSpec {
  key: string
  label: string
  unit?: string
}

/** Validate the instruction against the metrics contract; throw on mismatch. */
function parseMetrics({ instruction }: UiSurfaceProps): { items: ReadonlyArray<MetricSpec>, values: Readonly<Record<string, unknown>> } {
  const p = asRecord(instruction.props)
  const items = asArray(p.items).map((entry) => {
    const record = asRecord(entry)
    const key = asString(record.key)
    return { key, label: asString(record.label ?? record.key), unit: optionalString(record.unit) }
  })
  if (items.length === 0) throw new TypeError('items must be non-empty')
  return { items, values: asRecord(asRecord(instruction.data).values) }
}

const styles = {
  row: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 10,
  } satisfies CSSProperties,
  card: {
    flex: '1 1 120px',
    minWidth: 120,
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 10,
    padding: '10px 12px',
    display: 'grid',
    gap: 2,
  } satisfies CSSProperties,
  value: { fontSize: 22, fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
  label: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.4 },
}

/** The registered `metrics` surface. */
export function MetricsSurface(props: UiSurfaceProps): ReactNode {
  const { items, values } = parseMetrics(props)
  return (
    <div data-hibuddy-genui-surface="metrics" style={styles.row}>
      {items.map((item) => {
        const value = values[item.key]
        const text = typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) : '—'
        return (
          <div key={item.key} style={styles.card} className="hg-metric">
            <span style={styles.value}>
              {text}
              {item.unit !== undefined && <span style={{ fontSize: 12, fontWeight: 500, marginLeft: 2, color: 'var(--dsw-alias-label-secondary)' }}>{item.unit}</span>}
            </span>
            <span style={styles.label}>{item.label}</span>
          </div>
        )
      })}
    </div>
  )
}
