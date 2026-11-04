/** HiBuddy enhanced approval card: full tool arguments, impact note, and a session-scope re-ask waiver. */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { recordApprovalDecision } from './run-timeline/decisions.ts'

/**
 * Wire path of the coworker session-grant API. Must stay in sync with
 * `GRANTS_PATH` in `@hibuddy/coworker` `src/grants-api.ts`; duplicated as a
 * literal because the client bundle must not import host-side code.
 */
const GRANTS_PATH = '/hibuddy/approvals/grants'

/**
 * Code-execution tools never get the waiver button — mirrors `L2_TOOLS` in
 * `@hibuddy/coworker` `src/grading.ts` (SR-01: 免再询不可用于代码执行); the
 * grants API rejects them server-side regardless.
 */
const L2_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])

/** Full props of the composer takeover: chain owner seat + our locale + the elected request. */
export type HibuddyApprovalProps =
  & PropsRuntime<'conversation.composer'>
  & PropsLocale<'hibuddy-approval'>
  & { matched: PendingApproval }
  & {
    /** Resolve requester-owned copy in the active UI language (registration inject). */
    resolveReason(reason: NonNullable<PendingApproval['displayReason']>): string
  }

/** Card surface reusing the dsh theme tokens (theme-safe without a CSS pipeline). */
const styles = {
  root: {
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 'var(--dsw-radius-xl)',
    boxShadow: 'var(--dsw-shadow-lv2)',
    padding: '14px 16px',
    display: 'grid',
    gap: 10,
  } satisfies CSSProperties,
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    color: 'var(--dsw-alias-state-warn-primary)',
  },
  headline: { fontSize: 14, fontWeight: 600, lineHeight: 1.5 },
  note: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
  error: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-state-error-primary)' },
  argsLabel: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  args: {
    margin: 0,
    padding: '8px 10px',
    border: '1px solid var(--dsw-specific-input-major)',
    borderRadius: 8,
    maxHeight: 180,
    overflow: 'auto',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  } satisfies CSSProperties,
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' as const },
}

/** Locate the chat Tool-call node correlated with the request and return its raw arguments. */
function argsRawOf(useChat: HibuddyApprovalProps['useChat'], callId: string | undefined): string | undefined {
  return useChat((snapshot) => {
    if (callId === undefined) return undefined
    for (const node of snapshot.nodes.values()) {
      const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
      if (root !== undefined && root.callId === callId && !('kind' in root) && root.phase === 'start') {
        return root.argsRaw
      }
    }
    return undefined
  })
}

/**
 * Render the enhanced card; one instance per request via the remount key, so
 * answered/error state resets with each new approval.
 */
export function HibuddyApprovalCard(props: HibuddyApprovalProps): ReactNode {
  return <ApprovalFlow key={props.matched.key} {...props} />
}

function ApprovalFlow(props: HibuddyApprovalProps): ReactNode {
  const { matched: approval, t, useChat, resolveReason } = props
  const title = approval.displayReason === undefined
    ? approval.reason
    : resolveReason(approval.displayReason)
  const argsRaw = argsRawOf(useChat, approval.callId)
  const [answered, setAnswered] = useState(false)
  const [grantFailed, setGrantFailed] = useState(false)
  const grantable = !L2_TOOLS.has(approval.toolName)
  const run = (send: () => Promise<void>): void => {
    if (!approval.answerable || answered) return
    setGrantFailed(false)
    setAnswered(true)
    void send().catch(() => {
      // Keep the card alive on failure so the user can retry or reject.
      setAnswered(false)
      setGrantFailed(true)
    })
  }
  // Decision mirror (S5-2, FR-08/SR-01): successful answers join the Run
  // timeline by callId; the durable audit stays in the session log (a denial
  // also re-emerges via the failed tool result after a reload).
  const onReject = async (): Promise<void> => {
    await approval.answer('rejected')
    recordApprovalDecision(approval.callId, approval.toolName, 'rejected')
  }
  const onApprove = async (): Promise<void> => {
    await approval.answer('allowed-once')
    recordApprovalDecision(approval.callId, approval.toolName, 'approved')
  }
  const onAllowSession = async (): Promise<void> => {
    const response = await fetch(GRANTS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: String(approval.sessionId), toolName: approval.toolName }),
    })
    if (!response.ok) throw new Error(`grant request failed: ${String(response.status)}`)
    await approval.answer('allowed-once')
    recordApprovalDecision(approval.callId, approval.toolName, 'waived')
  }
  return (
    <div style={styles.root} data-hibuddy-approval="" aria-busy={answered}>
      <div style={styles.strip}><StateDot state={answered ? 'ongoing' : 'warning'} />{t('waiting')}</div>
      <div
        style={{ display: 'grid', gap: 10, maxHeight: 320, overflow: 'auto' }}
        tabIndex={0}
        role="group"
        aria-label={t('detail.aria')}
      >
        <div style={styles.headline}>{title ?? t('escalation', { toolName: approval.toolName })}</div>
        <p style={styles.note}>{t('impact')}</p>
        {argsRaw !== undefined && (
          <div style={{ display: 'grid', gap: 4 }}>
            <div style={styles.argsLabel}>{t('args')}</div>
            <pre style={styles.args}>{argsRaw}</pre>
          </div>
        )}
        {grantFailed && <p style={styles.error}>{t('grantFailed')}</p>}
      </div>
      <div style={styles.actions}>
        <Button variant="outline" disabled={answered} onClick={() => { run(onReject) }}>
          {t('reject')}
        </Button>
        <Button variant="primary" disabled={answered} onClick={() => { run(onApprove) }}>
          {t('approve')}
        </Button>
        {grantable && (
          <Button variant="outline" disabled={answered} onClick={() => { run(onAllowSession) }}>
            {t('allowSession')}
          </Button>
        )}
      </div>
      {grantable && <p style={styles.note}>{t('grantable', { toolName: approval.toolName })}</p>}
    </div>
  )
}
