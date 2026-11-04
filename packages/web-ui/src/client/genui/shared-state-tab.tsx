/**
 * Right-sidebar shared-state tab body (PRD FR-05, S4-6): the user's editing
 * surface for the run-level shared task state.
 *
 * Content comes from the shared-state store, fed by the chat-scoped turn
 * tails from the durable `shared_state` tool results (authoritative, with
 * source + time provenance). The user's own edit lands optimistically
 * (source `user`, stamped now) and is also sent to the Agent as one
 * `[shared-state update]` queued-turn message via the conversation-send seam
 * (S4-5) — the model relays it into the `shared_state` tool with
 * `source:"user"`, whose settled call then re-feeds the same value
 * (idempotent merge). A rejected relay (a newer value already held) is
 * reported by the model, and the panel keeps showing the holder (新者为准).
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { sendGenuiText } from './conversation-send.ts'
import { recordSharedStatePanelEdit, useSharedState } from './shared-state-store.ts'

/** Full props of the shared-state tab body: the sidebar's tab hook + our locale. */
export type GenuiSharedStateTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'hibuddy-genui'>

const styles = {
  root: { display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 10, padding: 12, minHeight: 0 } satisfies CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  badge: {
    flex: 'none',
    fontSize: 11,
    lineHeight: '18px',
    padding: '0 8px',
    borderRadius: 999,
    border: '1px solid var(--dsw-specific-input-major)',
    color: 'var(--dsw-alias-label-tertiary)',
    textOverflow: 'ellipsis',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
  } satisfies CSSProperties,
  title: {
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.5,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  body: { minHeight: 0, overflow: 'auto', display: 'grid', gap: 8, alignContent: 'start' } satisfies CSSProperties,
  empty: { margin: 'auto', fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary)', maxWidth: 320, textAlign: 'center' as const },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(72px, max-content) 1fr auto',
    gap: 8,
    alignItems: 'baseline',
    padding: '6px 10px',
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 8,
  } satisfies CSSProperties,
  key: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  value: {
    margin: 0,
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: 12,
    lineHeight: 1.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } satisfies CSSProperties,
  provenance: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' as const },
  source: {
    padding: '0 7px',
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 999,
    lineHeight: '17px',
  } satisfies CSSProperties,
  edit: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr) auto', gap: 6 } satisfies CSSProperties,
  input: {
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 8,
    background: 'transparent',
    color: 'inherit',
    fontSize: 13,
    lineHeight: '26px',
    padding: '0 10px',
    minWidth: 0,
  } satisfies CSSProperties,
  save: {
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 8,
    background: 'transparent',
    color: 'inherit',
    fontSize: 13,
    lineHeight: '26px',
    padding: '0 14px',
    cursor: 'pointer',
  } satisfies CSSProperties,
  hint: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
  note: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-warn-primary)' },
}

/** One-line value digest for an entry row. */
function valueDigest(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? String(value)
    return text.length > 64 ? `${text.slice(0, 64)}…` : text
  } catch {
    return '(…)'
  }
}

/** Parse the edit input: JSON when it parses, a raw string otherwise. */
function parseValueInput(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/**
 * The registered shared-state tab body: provenance-stamped entries over the
 * store, plus one edit row that optimistically records the user's write and
 * queues the relay message to the Agent.
 */
export function GenuiSharedStateTab(props: GenuiSharedStateTabProps): ReactNode {
  const { t, sessionId } = props
  const snapshot = useSharedState(sessionId)
  const [keyInput, setKeyInput] = useState('')
  const [valueInput, setValueInput] = useState('')
  const [sent, setSent] = useState<'ok' | 'failed' | undefined>(undefined)

  const entries = Object.entries(snapshot).sort(([, a], [, b]) => b.at - a.at)

  const save = (): void => {
    const key = keyInput.trim()
    if (key === '' || valueInput.trim() === '' || sessionId === undefined) return
    const value = parseValueInput(valueInput)
    recordSharedStatePanelEdit(sessionId, key, value)
    const ok = sendGenuiText(sessionId, [
      '[shared-state update]',
      `key: ${key}`,
      `value: ${JSON.stringify(value)}`,
    ].join('\n'))
    setSent(ok ? 'ok' : 'failed')
    if (ok) setValueInput('')
  }

  return (
    <div style={styles.root} data-hibuddy-shared-state-tab="">
      <div style={styles.head}>
        <span style={styles.badge}>state</span>
        <span style={styles.title}>{t('stateTitle')}</span>
      </div>
      <div style={styles.body}>
        {entries.length === 0 && <p style={styles.empty}>{t('stateEmpty')}</p>}
        {entries.map(([key, entry]) => (
          <div key={key} style={styles.row} data-hibuddy-shared-state-row={key}>
            <span style={styles.key}>{key}</span>
            <pre style={styles.value}>{valueDigest(entry.value)}</pre>
            <span style={styles.provenance}>
              <span style={styles.source}>{entry.source}</span>
              <span>{new Date(entry.at).toLocaleTimeString()}</span>
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {sent !== undefined
          && (sent === 'ok'
            ? <p style={styles.hint}>{t('stateSent')}</p>
            : <p style={styles.note}>{t('formSendFailed')}</p>)}
        <div style={styles.edit}>
          <input
            style={styles.input}
            value={keyInput}
            placeholder={t('stateKeyPh')}
            onChange={(event) => setKeyInput(event.target.value)}
          />
          <input
            style={styles.input}
            value={valueInput}
            placeholder={t('stateValuePh')}
            onChange={(event) => setValueInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save()
            }}
          />
          <button type="button" style={styles.save} onClick={save}>{t('stateSave')}</button>
        </div>
        <p style={styles.hint}>{t('stateHint')}</p>
      </div>
    </div>
  )
}
