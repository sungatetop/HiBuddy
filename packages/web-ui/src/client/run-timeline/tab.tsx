/**
 * Right-sidebar Run-timeline tab body (PRD FR-08, S5-2): read-only review of
 * every run (conversation turn) in the viewed session with live append.
 *
 * Unlike the canvas/shared-state tabs, this body owns its data directly: it
 * subscribes to the session binding's event source (the contiguous event
 * window the Conversation assembles from — populated for the open session and
 * appended live as the run progresses), and re-derives the timelines with the
 * pure projection on every publication. No chat-scope feeder is involved, so
 * the tab also reflects runs that streamed while the page was closed (the
 * window rebuilds from durable history on reload).
 *
 * Approval decisions pressed on HiBuddy cards are joined by callId from the
 * page-lifetime decisions mirror. The export button renders the selected run
 * as one Markdown document and hands it to the browser download seam.
 */
import { useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useApprovalDecisions } from './decisions.ts'
import { deriveRunTimelines, type RunStatus, type RunTimelineItem } from './derive.ts'
import { downloadRunMarkdown, type RunExportText } from './markdown.ts'

/** Full props of the tab body: sidebar seat + locale + the event-source seam. */
export type GenuiRunTimelineTabProps = PropsRuntime<'sidebar.right.pane.tab'> &
  PropsLocale<'hibuddy-run'> & {
    /** Resolve the viewed session's event source (registration inject). */
    getEventSource(sessionId: string): SessionEventSource | undefined
  }

/** Window-shaped constant for a session without a binding. */
const EMPTY_WINDOW: SessionEventWindow = {
  entries: [],
  hasMore: false,
  revision: 0,
  change: { kind: 'replace', entries: [] },
}

/** Subscribe seam for a session without a binding. */
const NOOP_SUBSCRIBE = (): (() => void) => () => undefined

/** Snapshot seam for a session without a binding. */
const EMPTY_SNAPSHOT = (): SessionEventWindow => EMPTY_WINDOW

/** Read `{ turn }` out of the navigation params (caller and body meet at our own convention). */
function navTurn(params: unknown): number | undefined {
  if (params === null || typeof params !== 'object') return undefined
  const value = (params as { turn?: unknown }).turn
  return typeof value === 'number' ? value : undefined
}

const styles = {
  root: { display: 'grid', gridTemplateRows: 'auto auto 1fr', gap: 10, padding: 12, minHeight: 0 } satisfies CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { fontSize: 14, fontWeight: 600, lineHeight: 1.5, flex: 1, minWidth: 0 },
  runBar: { display: 'flex', flexWrap: 'wrap', gap: 6 } satisfies CSSProperties,
  runChip: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 999,
    background: 'transparent',
    color: 'inherit',
    fontSize: 12,
    lineHeight: '24px',
    padding: '0 10px',
    cursor: 'pointer',
  } satisfies CSSProperties,
  runChipActive: {
    borderColor: 'var(--dsw-specific-input-active, var(--dsw-specific-input-major))',
    background: 'var(--dsw-specific-input-minor, transparent)',
  } satisfies CSSProperties,
  body: { minHeight: 0, overflow: 'auto', display: 'grid', gap: 8, alignContent: 'start' } satisfies CSSProperties,
  empty: { margin: 'auto', fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center' as const },
  meta: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', margin: 0 } satisfies CSSProperties,
  failNote: { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-danger-primary)', margin: 0 } satisfies CSSProperties,
  item: { display: 'grid', gap: 4, padding: '8px 10px', border: '1px solid var(--dsw-specific-input-major)', borderRadius: 8 } satisfies CSSProperties,
  itemHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const, fontSize: 12 },
  badge: {
    fontSize: 11,
    lineHeight: '18px',
    padding: '0 8px',
    borderRadius: 999,
    border: '1px solid var(--dsw-specific-input-major)',
    color: 'var(--dsw-alias-label-secondary)',
  } satisfies CSSProperties,
  name: { fontWeight: 600 },
  muted: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } satisfies CSSProperties,
  ok: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)' } satisfies CSSProperties,
  fail: { fontSize: 12, color: 'var(--dsw-alias-state-danger-primary)' } satisfies CSSProperties,
  warn: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } satisfies CSSProperties,
  stepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
    marginTop: 4,
  } satisfies CSSProperties,
  stepLine: { flex: 1, height: 1, background: 'var(--dsw-specific-input-major)' } satisfies CSSProperties,
  details: { fontSize: 12 } satisfies CSSProperties,
  pre: {
    margin: '4px 0 0',
    padding: '8px 10px',
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 8,
    maxHeight: 200,
    overflow: 'auto',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  } satisfies CSSProperties,
  summary: {
    margin: 0,
    fontSize: 12,
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  } satisfies CSSProperties,
} satisfies Record<string, CSSProperties>

/** StateDot state for a run status. */
function statusDot(status: RunStatus): 'ongoing' | 'done' | 'error' | 'warning' {
  if (status.kind === 'running') return 'ongoing'
  if (status.kind === 'completed') return 'done'
  if (status.kind === 'error') return 'error'
  return 'warning'
}

/** StateDot state for a tool row. */
function toolDot(status: 'running' | 'ok' | 'error'): 'ongoing' | 'done' | 'error' {
  return status === 'running' ? 'ongoing' : status === 'ok' ? 'done' : 'error'
}

/** Human duration: `1.2s` / `2m03s`. */
function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/** `{ n }` interpolation for the turn-chip copy. */
function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** Locale text of a run status (the Markdown export shares it). */
function statusTextOf(status: RunStatus | undefined, t: GenuiRunTimelineTabProps['t']): string {
  if (status === undefined) return ''
  return t(`status.${status.kind}` as never) as string
}

/** One timeline row renderer. */
function TimelineItemRow({ item, t }: { item: RunTimelineItem; t: GenuiRunTimelineTabProps['t'] }): ReactNode {
  if (item.kind === 'step') {
    return (
      <div style={styles.stepRow}>
        <span>{t('step')} {item.step}</span>
        <span style={styles.stepLine} />
      </div>
    )
  }
  if (item.kind === 'prompt') {
    return (
      <div style={styles.item}>
        <div style={styles.itemHead}>
          <span style={styles.badge}>{t('prompt')}</span>
          <span style={styles.muted}>{new Date(item.at).toLocaleTimeString()}</span>
        </div>
        <p style={styles.summary}>{item.text}</p>
      </div>
    )
  }
  if (item.kind === 'tool') {
    return (
      <div style={styles.item} data-hibuddy-run-tool="">
        <div style={styles.itemHead}>
          <StateDot state={toolDot(item.status)} />
          <span style={styles.name}>{item.name}</span>
          {item.status === 'running' && <span style={styles.warn}>{t('toolRunning')}</span>}
          {item.status === 'ok' && <span style={styles.ok}>{t('toolOk')}</span>}
          {item.status === 'error' && <span style={styles.fail}>{t('toolError')}</span>}
          {item.durationMs !== undefined && <span style={styles.muted}>{t('duration')} {duration(item.durationMs)}</span>}
          {item.decision !== undefined && (
            <span style={styles.badge}>{t('approval')}: {t(`approval.${item.decision.decision}` as never) as string}</span>
          )}
        </div>
        {item.argsRaw !== '' && (
          <details style={styles.details}>
            <summary style={styles.muted}>{t('args')}</summary>
            <pre style={styles.pre}>{item.argsRaw}</pre>
          </details>
        )}
        {item.errorReason !== undefined && <p style={styles.fail}>{item.errorReason}</p>}
        {item.resultSummary !== undefined && <p style={styles.summary}>{item.resultSummary}</p>}
      </div>
    )
  }
  return (
    <div style={styles.item}>
      <div style={styles.itemHead}>
        <span style={styles.badge}>{t('output')}</span>
        {item.outputTokens !== undefined && <span style={styles.muted}>{t('tokens')} {item.outputTokens}</span>}
        {item.interrupted === true && <span style={styles.warn}>{t('interrupted')}</span>}
        <span style={styles.muted}>{new Date(item.at).toLocaleTimeString()}</span>
      </div>
      <details style={styles.details} open={item.text.length <= 400}>
        <summary style={styles.muted}>{item.text.length > 0 ? `${item.text.slice(0, 120)}${item.text.length > 120 ? '…' : ''}` : '…'}</summary>
        <pre style={styles.pre}>{item.text === '' ? '…' : item.text}</pre>
      </details>
    </div>
  )
}

/**
 * The registered tab body: run list over the derived timelines, the selected
 * run's read-only timeline, and the Markdown export action.
 */
export function GenuiRunTimelineTab(props: GenuiRunTimelineTabProps): ReactNode {
  const { useTabInfo, t, sessionId, getEventSource } = props
  const info = useTabInfo()
  const id = String(sessionId)
  // Bound observables per session generation; re-resolved when the viewed
  // session (or the binding face) changes. Hook calls stay unconditional —
  // without a binding the seams fall back to a constant empty window.
  const source = useMemo(() => {
    const found = getEventSource(id)
    return found === undefined
      ? undefined
      : { subscribe: found.subscribe.bind(found), getSnapshot: found.getSnapshot.bind(found) }
  }, [getEventSource, id])
  const subscribe = source?.subscribe ?? NOOP_SUBSCRIBE
  const getSnapshot = source?.getSnapshot ?? EMPTY_SNAPSHOT
  const eventWindow = useSyncExternalStore(subscribe, getSnapshot)
  const decisions = useApprovalDecisions()
  const runs = useMemo(() => deriveRunTimelines(eventWindow.entries, decisions), [eventWindow, decisions])

  const navigation = info.tab.navigation
  const [pinnedTurn, setPinnedTurn] = useState<number | undefined>(undefined)
  const requested = navTurn(navigation.params)
  const activeTurn = requested ?? pinnedTurn
  const active = runs.find((run) => run.turn === activeTurn) ?? runs[runs.length - 1]
  const statusText = statusTextOf(active?.status, t)

  if (active === undefined) {
    return <p style={styles.empty}>{t('empty')}</p>
  }
  return (
    <div style={styles.root} data-hibuddy-run-timeline-tab="">
      <div style={styles.head}>
        <span style={styles.title}>{interpolate(t('turn'), { n: String(active.turn) })}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => downloadRunMarkdown(active, id, t as RunExportText, statusText)}
        >
          {t('export')}
        </Button>
      </div>
      <div style={styles.runBar}>
        {runs.map((run) => (
          <button
            key={run.turn}
            type="button"
            style={{ ...styles.runChip, ...(run.turn === active.turn ? styles.runChipActive : {}) }}
            title={run.prompt}
            onClick={() => setPinnedTurn(run.turn)}
          >
            <StateDot state={statusDot(run.status)} />
            {interpolate(t('turn'), { n: String(run.turn) })}
          </button>
        ))}
      </div>
      <div style={styles.body}>
        <p style={styles.meta}>
          {t('prompt')}: {active.prompt === '' ? t('noPrompt') : active.prompt}
        </p>
        {active.status.kind === 'error' && <p style={styles.failNote}>{active.status.message}</p>}
        {active.items.map((item) => (
          <TimelineItemRow key={item.seq} item={item} t={t} />
        ))}
      </div>
    </div>
  )
}
