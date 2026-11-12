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
import { useEffect, type ReactNode } from 'react'
import type { ChatConversationViewNode, ChatNode, ChatSnapshot, ToolResultNode, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { openGenuiCanvas } from './canvas-open.ts'
import { recordCanvasVersion } from './canvas-store.ts'
import { readInstruction } from './instruction.ts'
import { GenuiSurfaceCard } from './render-ui-card.tsx'
import { recordClientRevision } from './revision-store.ts'
import { recordSharedStateToolWrite } from './shared-state-store.ts'
import { revealSharedState } from './shared-state-open.ts'

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

/** Settled `shared_state` set-calls of one turn (FR-05 authoritative writes). */
function settledSharedStateWrites(snapshot: ChatSnapshot, turn: number): ToolResultNode[] {
  const found: ToolResultNode[] = []
  for (const node of snapshot.nodes.values()) {
    if (node.visibility !== 'visible') continue
    const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
    if (root !== undefined && 'kind' in root && root.kind === 'tool-result' && root.name === 'shared_state' && nodeTurn(node) === turn) {
      found.push(root)
    }
  }
  return found
}

/**
 * The registered turnTail entry: one mirror card per settled render_ui call
 * of this turn; entries without content return null (contract requirement).
 *
 * Canvas recording (ADR-007 §3.3): settled `target=canvas` calls are recorded
 * into the canvas store here — the tail re-renders from the durable chat nodes
 * on every page load, which rebuilds the canvas tab's version history after a
 * reload. A brand-new canvas instance also auto-opens the canvas tab (reveal
 * semantics; already-open tabs just re-reveal).
 */
export function GenuiTurnTail(props: GenuiTurnTailProps): ReactNode {
  const { turn, useChat, t, sessionId } = props
  const calls = useChat((snapshot) => settledRenderUiCalls(snapshot, turn.turn))
  useEffect(() => {
    if (calls === undefined) return
    for (const call of calls) {
      // readInstruction reads the string fields (registering the observed
      // answers, so a still-growing view republishes and re-runs us), then
      // the closed() gate skips UNSETTLED views: a streaming view can parse
      // an intermediate shape, and the canvas store dedups by call id — the
      // wrong snapshot would stick forever (S4-6 E2E finding).
      const instruction = readInstruction(call.args)
      if (!call.args.closed()) continue
      // Revision tracker (G2, client half of the staleness gate): every
      // settled render_ui call feeds session → id → latest revision, so
      // surfaces older than the newest version render read-only. Reload-safe:
      // the tail rebuilds from durable nodes, replaying max-wins records.
      if (instruction.id !== undefined) recordClientRevision(sessionId, instruction.id, instruction.revision)
      if (instruction.target !== 'canvas' || instruction.id === undefined) continue
      const fresh = recordCanvasVersion(instruction, call.callId, turn.turn)
      if (fresh) openGenuiCanvas(instruction.id)
    }
  }, [calls, turn.turn, sessionId])
  // Shared-state feed (FR-05): settled `op:"set"` calls are the authoritative
  // writes — value/source from the call arguments, time from the result event.
  // Replays on page reload re-merge idempotently (newest-at-wins).
  const stateWrites = useChat((snapshot) => settledSharedStateWrites(snapshot, turn.turn))
  useEffect(() => {
    if (stateWrites === undefined || sessionId === undefined) return
    let fed = false
    for (const call of stateWrites) {
      const args = call.args
      if (!args.has('op') || args.text('op') !== 'set') continue
      const key = args.text('key')
      if (key === undefined) continue
      // Same closed() gate as the canvas feed above: an unsettled view must
      // not win the newest-at-wins merge with a partial value.
      if (!args.closed()) continue
      if (!args.complete('value')) continue
      const source = args.text('source') === 'user' ? 'user' : 'agent'
      // `text` reads string values, `value` reads non-string ones (the other
      // reader returns undefined) — a json-typed argument can be either.
      const value = args.text('value') ?? args.value('value')
      recordSharedStateToolWrite(sessionId, key, value, source, call.time)
      fed = true
    }
    // The first observed write reveals the panel (once per session per page
    // lifetime); the seam dedups, so reload replays stay quiet afterwards.
    if (fed) revealSharedState(sessionId)
  }, [stateWrites, sessionId])
  if (calls === undefined || calls.length === 0) return null
  return (
    <div data-hibuddy-genui-tail="" style={{ display: 'grid', gap: 10 }}>
      {calls.map((call) => (
        <GenuiSurfaceCard key={call.callId} block={call} t={t} sessionId={sessionId} />
      ))}
    </div>
  )
}
