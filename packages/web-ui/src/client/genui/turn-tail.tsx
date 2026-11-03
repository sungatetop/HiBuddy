/**
 * Turn-tail mirror (ADR-007 §3.3, S4-3): settled `render_ui` surfaces render
 * again at the completed Turn's tail, so generated UI stays visible in the
 * message flow — the native tool-call row tucks into the turn-process
 * disclosure ("已完成，用时 N 秒") once the turn closes, which would hide
 * inline surfaces behind a click.
 *
 * One mirror card per settled render_ui call of THIS turn (the toolview keyed
 * takeover still owns the in-panel row; the mirror is the always-visible
 * placement). Reload-safe: it reads the same durable chat nodes, so history
 * turns re-render their surfaces after a page reload (S4-4 version history
 * builds on this).
 */
import type { ReactNode } from 'react'
import type { ChatConversationViewNode, ChatNode, ChatSnapshot, ToolResultNode, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GenuiSurfaceCard } from './render-ui-card.tsx'

/** Full props of a turnTail list entry: turn location + our locale. */
export type GenuiTurnTailProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'hibuddy-genui'>

/** Turn number of a chat node: -1 for unresolved locations. */
function nodeTurn(node: ChatConversationViewNode): number {
  const location = node.location
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : -1
}

/** Settled render_ui calls of one turn, read from the chat snapshot. */
function settledRenderUiCalls(snapshot: ChatSnapshot, turn: number): ToolResultNode[] {
  const found: ToolResultNode[] = []
  for (const node of snapshot.nodes.values()) {
    if (node.visibility !== 'visible') continue
    const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
    if (root !== undefined && 'kind' in root && root.kind === 'tool-result' && root.name === 'render_ui' && nodeTurn(node) === turn) {
      found.push(root)
    }
  }
  return found
}

/**
 * The registered turnTail entry: one mirror card per settled render_ui call
 * of this turn; entries without content return null (contract requirement).
 */
export function GenuiTurnTail(props: GenuiTurnTailProps): ReactNode {
  const { turn, useChat, t } = props
  const calls = useChat((snapshot) => settledRenderUiCalls(snapshot, turn.turn))
  if (calls === undefined || calls.length === 0) return null
  return (
    <div data-hibuddy-genui-tail="" style={{ display: 'grid', gap: 10 }}>
      {calls.map((call) => (
        <GenuiSurfaceCard key={call.callId} block={call} t={t} />
      ))}
    </div>
  )
}
