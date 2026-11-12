/**
 * Generative-UI bubble attachment (genui-agui-optimization.md G4): renders a
 * kind='ui' ledger attachment INLINE in the butler chat. The attachment rides
 * only the reference (the /resident/api/ui-instruction route + revision); the
 * instruction JSON is fetched on mount and projected through the trusted-
 * component registry bundled from @hibuddy/web-ui/client-genui — the same
 * compiled-in surfaces and card chrome (skin.tsx) the conversation view uses
 * (SR-02: the model names a component key and supplies data; nothing it emits
 * is ever evaluated).
 *
 * Send-backs (form submit) go through the SAME chat channel
 * (POST /resident/api/messages) as one structured `@[ui:…]` text (G2), so the
 * butler pump's host-side revision gate sees chat-panel submissions
 * identically to any other user turn.
 */
import { Component, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import {
  accentStyle,
  registerGenuiSurfaces,
  setConversationSender,
  uiSurfaceOf,
  zh as genuiZh,
  GenuiSkin,
  type GenuiLocaleKey,
  type RenderUiInstruction,
} from '@hibuddy/web-ui/client-genui'
import { fetchUiInstruction, sendChat, type UiInstruction } from './api.ts'

// Module init (idempotent): fill the registry with the four built-ins and
// route surface events through the chat channel (the butler conversation has
// no dsh session binding — the message POST is the single queue).
registerGenuiSurfaces()
setConversationSender(async (_sessionId, text) => {
  await sendChat(text)
})

/** The deterministic butler session id (host `BUTLER_SESSION_ID` mirror). */
const BUTLER_SESSION_ID = 'resident-butler'

/** Namespace translate bound to the bundled zh dictionary. */
const t = (key: GenuiLocaleKey): string => genuiZh[key]

/**
 * Card chrome mirroring render-ui-card.tsx (theme tokens only — the bubble
 * must not hardcode colors, so it follows the shell's light/dark themes).
 */
const styles = {
  root: {
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 'var(--dsw-radius-xl)',
    padding: '12px 16px',
    display: 'grid',
    gap: 10,
  } satisfies CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } satisfies CSSProperties,
  badge: {
    flex: 'none',
    fontSize: 10,
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
  } satisfies CSSProperties,
  summary: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' } satisfies CSSProperties,
  note: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-warn-primary)' } satisfies CSSProperties,
  raw: {
    margin: 0,
    padding: '8px 10px',
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 8,
    maxHeight: 200,
    overflow: 'auto',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all',
  } satisfies CSSProperties,
}

/** Pretty-print a closed JSON value for the static fallback. */
function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Project a persisted instruction into the registry surface's input shape. */
function toSurfaceInstruction(instruction: UiInstruction): RenderUiInstruction {
  return {
    id: instruction.id,
    revision: instruction.revision,
    target: 'inline',
    title: undefined,
    component: instruction.component === 'chart' || instruction.component === 'form'
      || instruction.component === 'table' || instruction.component === 'metrics'
      ? instruction.component
      : undefined,
    props: instruction.props,
    data: instruction.data,
    provenance: instruction.provenance,
    summary: instruction.summary,
  }
}

/** Error boundary: a throwing surface degrades to the static fallback (SR-02). */
class BubbleBoundary extends Component<{ instruction: RenderUiInstruction; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <>
          <p style={styles.note}>{t('degraded')}</p>
          <pre style={styles.raw} className="hg-raw">{pretty({ props: this.props.instruction.props, data: this.props.instruction.data })}</pre>
        </>
      )
    }
    return this.props.children
  }
}

/**
 * One kind='ui' attachment: chrome (component badge + summary) around the
 * registry surface. Unknown component keys and fetch failures degrade to the
 * static summary + raw payload, mirroring the conversation-view card.
 */
export function GenuiBubble({ src, name }: { src: string; name: string }): ReactNode {
  const [instruction, setInstruction] = useState<UiInstruction | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false
    fetchUiInstruction(src)
      .then((value) => {
        if (!disposed) setInstruction(value)
      })
      .catch(() => {
        if (!disposed) setFailed(true)
      })
    return () => {
      disposed = true
    }
  }, [src])

  if (failed) {
    return (
      <div style={styles.root} className="hg-card" data-hibuddy-genui="">
        <GenuiSkin />
        <p style={styles.note}>界面内容加载失败。</p>
      </div>
    )
  }
  if (instruction === undefined) {
    return (
      <div style={styles.root} className="hg-card" data-hibuddy-genui="">
        <GenuiSkin />
        <p style={styles.summary}>{name}</p>
        <p style={styles.summary}>正在加载界面…</p>
      </div>
    )
  }
  const surface = toSurfaceInstruction(instruction)
  const Surface = surface.component !== undefined ? uiSurfaceOf(surface.component) : undefined
  return (
    <div
      style={{ ...styles.root, ...accentStyle(surface.component) }}
      className="hg-card"
      data-hibuddy-genui=""
      data-hibuddy-genui-component={instruction.component}
    >
      <GenuiSkin />
      <div style={styles.head}>
        <span style={styles.badge} className="hg-badge">{instruction.component}</span>
        {instruction.summary !== undefined && <span style={styles.title}>{instruction.summary}</span>}
      </div>
      {instruction.provenance !== undefined && (
        <p style={styles.summary} className="hg-provenance">{instruction.provenance}</p>
      )}
      {surface.component === undefined || Surface === undefined
        ? (
            <>
              <p style={styles.note}>{t('unknown')}</p>
              <pre style={styles.raw} className="hg-raw">{pretty({ props: surface.props, data: surface.data })}</pre>
            </>
          )
        : (
            <BubbleBoundary instruction={surface}>
              <Surface instruction={surface} t={t} sessionId={BUTLER_SESSION_ID} />
            </BubbleBoundary>
          )}
    </div>
  )
}
