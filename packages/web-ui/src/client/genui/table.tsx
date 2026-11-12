/**
 * `table` surface: structured rows as a themed HTML table.
 *
 * props: { columns: [{ key, label }], maxRows?: number }
 * data:  { rows: [{ [key]: string | number }] }
 *
 * Cell rendering is string-projection only (no HTML injection — React escapes
 * text nodes; SR-02). Malformed shapes throw into the static fallback.
 */
import type { ReactNode } from 'react'
import { asArray, asRecord, asString, optionalNumber, truncate } from './guards.ts'
import type { UiSurfaceProps } from './registry.ts'

/** Default visible-row cap when props.maxRows is absent. */
const DEFAULT_MAX_ROWS = 50

interface ColumnSpec {
  key: string
  label: string
}

/** Validate the instruction against the table contract; throw on mismatch. */
function parseTable({ instruction }: UiSurfaceProps): { columns: ReadonlyArray<ColumnSpec>, rows: ReadonlyArray<Record<string, unknown>>, maxRows: number } {
  const p = asRecord(instruction.props)
  const columns = asArray(p.columns).map((entry) => {
    const record = asRecord(entry)
    const key = asString(record.key)
    return { key, label: asString(record.label ?? record.key) }
  })
  if (columns.length === 0) throw new TypeError('columns must be non-empty')
  const rows = asArray(asRecord(instruction.data).rows).map(asRecord)
  if (rows.length === 0) throw new TypeError('data.rows must be non-empty')
  return { columns, rows, maxRows: optionalNumber(p.maxRows) ?? DEFAULT_MAX_ROWS }
}

/** Cell text: string as-is, number formatted, everything else JSON — never markup. */
function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value * 100) / 100)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (value === undefined || value === null) return '—'
  return JSON.stringify(value)
}

const styles = {
  wrap: { overflowX: 'auto' as const },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 12,
    lineHeight: 1.5,
  },
  th: {
    textAlign: 'left' as const,
    padding: '6px 10px',
    borderBottom: '1px solid var(--dsw-specific-input-major)',
    color: 'var(--dsw-alias-label-tertiary)',
    fontWeight: 600,
    whiteSpace: 'nowrap' as const,
  },
  td: {
    padding: '6px 10px',
    borderBottom: '1px solid var(--dsw-specific-input-major)',
    verticalAlign: 'top' as const,
    maxWidth: 320,
    wordBreak: 'break-word' as const,
  },
  note: { margin: '4px 0 0', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
}

/** The registered `table` surface. */
export function TableSurface(props: UiSurfaceProps): ReactNode {
  const { columns, rows, maxRows } = parseTable(props)
  const shown = rows.slice(0, maxRows)
  return (
    <div data-hibuddy-genui-surface="table">
      <div style={styles.wrap}>
        <table style={styles.table} className="hg-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} style={styles.th} scope="col">{truncate(column.label, 24)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {columns.map((column) => (
                  <td key={column.key} style={styles.td}>{truncate(cellText(row[column.key]), 120)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <p style={styles.note}>仅显示前 {shown.length} 行（共 {rows.length} 行）</p>
      )}
    </div>
  )
}
