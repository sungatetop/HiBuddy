/**
 * Right-sidebar canvas tab body (ADR-007 §3.3): the full-surface placement for
 * `target=canvas` instructions.
 *
 * Stage two of the tab-type registration — the body under definition id
 * `hibuddy.genui-canvas`. Content is read from the canvas store (fed by the
 * chat-scoped turn tails from the durable chat nodes), so the tab survives
 * turn boundaries, page reloads, and re-opens; the version bar browses an
 * instance's ascending versions (version review). `openTab` navigation params
 * (`{ canvasId }`) switch the shown instance.
 *
 * The injected `tabInfo` hook is the slot framework's reactive read of the
 * sidebar/tab state (same pattern as the chat slots' `useChat` prop).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useCanvasInstances } from './canvas-store.ts'
import { SurfaceBody } from './render-ui-card.tsx'

/** Full props of the canvas tab body: the sidebar's tab hook + our locale. */
export type GenuiCanvasTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'hibuddy-genui'>

/** Read `{ canvasId }` out of the navigation params (caller and body meet at our own convention). */
function navCanvasId(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object') return undefined
  const value = (params as { canvasId?: unknown }).canvasId
  return typeof value === 'string' ? value : undefined
}
const styles = {
  root: { display: 'grid', gridTemplateRows: 'auto auto 1fr', gap: 10, padding: 12, minHeight: 0 } satisfies CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  badge: {
    flex: 'none',
    fontSize: 11,
    lineHeight: '18px',
    padding: '0 8px',
    borderRadius: 999,
    border: '1px solid var(--dsw-specific-input-major)',
    color: 'var(--dsw-alias-label-tertiary)',
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
  versionBar: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  versionButton: {
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    fontSize: 12,
    lineHeight: '22px',
    padding: '0 8px',
    cursor: 'pointer',
  } satisfies CSSProperties,
  body: { minHeight: 0, overflow: 'auto' } satisfies CSSProperties,
  empty: { margin: 'auto', fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary)', maxWidth: 320, textAlign: 'center' as const },
}

/** `{ label }` interpolation for the two version-bar copy keys. */
function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/**
 * The registered canvas tab body: instance + version selection over the canvas
 * store, rendering the same registry surfaces as the flow cards.
 */
export function GenuiCanvasTab(props: GenuiCanvasTabProps): ReactNode {
  const { useTabInfo, t } = props
  const instances = useCanvasInstances()
  const info = useTabInfo()
  const navigation = info.tab.navigation

  // The navigation params name the instance to show (canvas card's open
  // button and the turn-tail auto-open); undefined params keep the current
  // selection (the newest instance initially).
  const [pinnedId, setPinnedId] = useState<string | undefined>(undefined)
  const [versionIndex, setVersionIndex] = useState<number | undefined>(undefined)
  useEffect(() => {
    const requested = navCanvasId(navigation.params)
    if (requested !== undefined) setPinnedId(requested)
  }, [navigation])

  const active = instances.find((instance) => instance.id === pinnedId) ?? instances[instances.length - 1]
  const versions = active?.versions ?? []
  const index = versionIndex === undefined ? versions.length - 1 : Math.min(versionIndex, versions.length - 1)
  const version = versions[index]

  if (active === undefined || version === undefined) {
    return <p style={styles.empty}>{t('canvasEmpty')}</p>
  }
  const instruction = version.instruction
  const component = instruction.component
  const browsed = index < versions.length - 1
  return (
    <div style={styles.root} data-hibuddy-genui-canvas-tab="">
      <div style={styles.head}>
        {component !== undefined && <span style={styles.badge}>{component}</span>}
        <span style={styles.title}>{instruction.title || component}</span>
      </div>
      <div style={styles.versionBar}>
        <button
          type="button"
          style={styles.versionButton}
          disabled={index <= 0}
          onClick={() => setVersionIndex(index - 1)}
        >
          ‹
        </button>
        <span>{interpolate(t('canvasVersion'), { i: String(index + 1), n: String(versions.length) })}</span>
        <button
          type="button"
          style={styles.versionButton}
          disabled={!browsed}
          onClick={() => setVersionIndex(browsed && index + 1 < versions.length - 1 ? index + 1 : undefined)}
        >
          ›
        </button>
        {browsed && <button type="button" style={styles.versionButton} onClick={() => setVersionIndex(undefined)}>{t('canvasLatest')}</button>}
        <span>{interpolate(t('canvasTurn'), { n: String(version.turn + 1) })}</span>
      </div>
      <div style={styles.body}>
        <SurfaceBody instruction={instruction} t={t} />
      </div>
    </div>
  )
}
