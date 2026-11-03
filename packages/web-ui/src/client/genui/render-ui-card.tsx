/**
 * `tool.call.toolview` occupant keyed `render_ui` (ADR-007 §3.3).
 *
 * The official keyed Tool-view slot supplies explicit phase props:
 * - `preparing`: the argument stream is growing — read the streaming string
 *   prefixes and show a skeleton card (never into state; read during render);
 * - `start`/`result`: arguments closed — project the instruction and hand it
 *   to the registry surface, with a static fallback for unknown keys, missing
 *   fields, and render throws (SR-02 degradation).
 *
 * Styling reuses dsh theme tokens (theme-safe without a CSS pipeline), as the
 * approval card does.
 */
import { Component, type CSSProperties, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { openGenuiCanvas } from './canvas-open.ts'
import { instructionReady, readInstruction, type RenderUiInstruction } from './instruction.ts'
import { uiSurfaceOf, type SurfaceTranslate, type UiSurfaceProps } from './registry.ts'

/** Full props of the registered toolview: phase owner seat + our locale. */
export type RenderUiCardProps = ToolCallViewProps & PropsLocale<'hibuddy-genui'>

/** Card surface reusing the dsh theme tokens. */
const styles = {
  root: {
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 'var(--dsw-radius-xl)',
    padding: '12px 14px',
    display: 'grid',
    gap: 8,
  } satisfies CSSProperties,
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
  summary: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
  note: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-warn-primary)' },
  canvasActions: { display: 'flex', justifyContent: 'flex-end' },
  raw: {
    margin: 0,
    padding: '8px 10px',
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 8,
    maxHeight: 220,
    overflow: 'auto',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all',
  } satisfies CSSProperties,
}

/** Translate bound to our namespace. */
type Translate = SurfaceTranslate

/** Pretty-print a closed JSON value for the static fallback. */
function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Static degradation view (SR-02): readable summary plus the raw instruction.
 * Shown for unregistered component keys (`degraded=false`), incomplete
 * instructions (`degraded=false`), and render failures (`degraded=true`, via
 * the boundary below).
 */
function FallbackSurface({ instruction, t, degraded }: UiSurfaceProps & { degraded: boolean }): ReactNode {
  return (
    <>
      {!degraded && instruction.component !== undefined && <p style={styles.note}>{t('unknown')}</p>}
      {degraded && <p style={styles.note}>{t('degraded')}</p>}
      <pre style={styles.raw}>{pretty({ props: instruction.props, data: instruction.data })}</pre>
    </>
  )
}

/** Error boundary: a throwing surface degrades to the static fallback (SR-02). */
class SurfaceBoundary extends Component<{ surface: UiSurfaceProps; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override render(): ReactNode {
    if (this.state.failed) return <FallbackSurface {...this.props.surface} degraded />
    return this.props.children
  }
}

/** Settled body: registry surface when possible, static fallback otherwise. */
export function SurfaceBody({ instruction, t }: { instruction: RenderUiInstruction; t: Translate }): ReactNode {
  const component = instruction.component
  if (!instructionReady(instruction) || component === undefined) {
    return <FallbackSurface instruction={instruction} t={t} degraded={false} />
  }
  const Surface = uiSurfaceOf(component)
  if (Surface === undefined) return <FallbackSurface instruction={instruction} t={t} degraded={false} />
  return (
    <SurfaceBoundary surface={{ instruction, t }}>
      <Surface instruction={instruction} t={t} />
    </SurfaceBoundary>
  )
}

/**
 * Settled generative-UI card: chrome (badge/title/summary) + registry surface.
 * Shared by the toolview's start/result phases and the turn-tail mirror, so
 * both placements render one identical card for the same call.
 *
 * Canvas routing (ADR-007 §3.3): a `target=canvas` instruction renders as a
 * COMPACT card here (chrome + an open-canvas button) — the full surface lives
 * in the right-sidebar canvas tab, keyed by the instruction id; the turn-tail
 * recorder feeds that tab's version history.
 */
export function GenuiSurfaceCard({ block, t }: { block: StartedToolCall | ToolResultNode; t: Translate }): ReactNode {
  const instruction = readInstruction(block.args)
  const component = instruction.component
  const title = instruction.title || component || t('preparing')
  const canvasId = instruction.target === 'canvas' && instruction.id !== undefined ? instruction.id : undefined
  return (
    <div
      style={styles.root}
      data-hibuddy-genui=""
      data-hibuddy-genui-component={component ?? ''}
      data-hibuddy-genui-phase="result"
      {...(canvasId !== undefined ? { 'data-hibuddy-genui-canvas': canvasId } : {})}
    >
      <div style={styles.head}>
        <span style={styles.badge}>{canvasId !== undefined ? 'canvas' : component}</span>
        <span style={styles.title}>{title}</span>
      </div>
      {instruction.summary !== undefined && <p style={styles.summary}>{instruction.summary}</p>}
      {canvasId !== undefined
        ? (
            <div style={styles.canvasActions}>
              <Button variant="outline" onClick={() => openGenuiCanvas(canvasId)}>{t('canvasOpen')}</Button>
            </div>
          )
        : <SurfaceBody instruction={instruction} t={t} />}
    </div>
  )
}

/**
 * Render the toolview. Reads the argument view during render only (per the
 * contract: a preparing view grows in place; the host republishes the block
 * as the stream grows, re-rendering this component).
 */
export function RenderUiCard(props: RenderUiCardProps): ReactNode {
  const { block, t } = props
  // The phase discriminant owns the union; TS cannot correlate the two props,
  // so the settled branch asserts the runtime-guaranteed narrow.
  if (props.phase !== 'preparing') return <GenuiSurfaceCard block={block as StartedToolCall | ToolResultNode} t={t} />
  const instruction = readInstruction(block.args)
  const component = instruction.component
  const title = instruction.title || component || t('preparing')
  return (
    <div
      style={styles.root}
      data-hibuddy-genui=""
      data-hibuddy-genui-component={component ?? ''}
      data-hibuddy-genui-phase="preparing"
    >
      <div style={styles.head}>
        {component !== undefined && <span style={styles.badge}>{component}</span>}
        <span style={styles.title}>{title}</span>
        <StateDot state="ongoing" />
      </div>
      {instruction.summary !== undefined && <p style={styles.summary}>{instruction.summary}</p>}
      <p style={styles.summary}>{t('preparing')}</p>
    </div>
  )
}
