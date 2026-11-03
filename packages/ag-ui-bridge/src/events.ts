/**
 * Pure SessionEvent → AG-UI event mapping (ADR-009 §3.2 table).
 *
 * The bridge maps dsh's durable session feed onto the AG-UI 1.0 protocol:
 * per-message granularity for assistant text (TEXT_MESSAGE_* trio carrying the
 * whole message as one delta — the process-local token stream has no public
 * subscription API, a registered MVP degradation), tool calls as the
 * START/ARGS/END + RESULT event pair, todo state as a full STATE_SNAPSHOT,
 * steps as STEP_*. Events without an AG-UI counterpart (user echo, request
 * headers, …) map to nothing.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AguiEvent } from './types.ts'

/** Per-run mapping state the pure mapper threads through (open-message attribution). */
export interface MappingState {
  /** Most recent assistant message id — TOOL_CALL_START.parentMessageId target. */
  lastAssistantMessageId: string | undefined
}

export function newMappingState(): MappingState {
  return { lastAssistantMessageId: undefined }
}

/** Visible text of one assistant stream: text-chunk deltas joined (content fallback below). */
function streamText(stream: unknown): string {
  if (!Array.isArray(stream)) return ''
  let text = ''
  for (const record of stream) {
    if (
      typeof record === 'object' && record !== null
      && (record as { type?: unknown }).type === 'text-chunks'
      && Array.isArray((record as { texts?: unknown }).texts)
    ) {
      for (const piece of (record as { texts: unknown[] }).texts) {
        if (typeof piece === 'string') text += piece
      }
    }
  }
  return text
}

/** Visible text of a dsh content block list (text blocks joined; reasoning blocks skipped). */
function contentText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** Extract the whole visible text of one assistant/message event. */
function assistantTextOf(data: { message: { content: readonly ContentBlock[] }; stream: unknown }): string {
  const fromStream = streamText(data.stream)
  return fromStream !== '' ? fromStream : contentText(data.message.content)
}

/** turn/end reason → the run's AG-UI terminal event. */
export function terminalOf(reason: unknown, threadId: string, runId: string): AguiEvent {
  const kind = (typeof reason === 'object' && reason !== null && 'kind' in reason)
    ? String((reason as { kind: unknown }).kind)
    : 'completed'
  switch (kind) {
    case 'aborted':
    case 'interrupted':
      return { type: 'RUN_FINISHED', threadId, runId, outcome: { type: 'cancelled' } }
    case 'error': {
      const failure = (reason as { error?: { message?: unknown; code?: unknown } }).error
      const message = typeof failure?.message === 'string' && failure.message !== ''
        ? failure.message
        : `turn failed: ${JSON.stringify(reason)}`
      const code = typeof failure?.code === 'string' ? failure.code : undefined
      return { type: 'RUN_ERROR', message, ...(code === undefined ? {} : { code }) }
    }
    case 'blocked':
      return { type: 'RUN_ERROR', message: 'the turn ended blocked and cannot continue', code: 'blocked' }
    // completed / max-tokens / forked (and unknown plugin reasons): a normal finish.
    default:
      return { type: 'RUN_FINISHED', threadId, runId }
  }
}

/**
 * Map one non-terminal session event to zero or more AG-UI events.
 * `threadId`/`runId` stamping is the run layer's job (it owns the open run);
 * this function leaves those fields to be filled there.
 */
export function mapSessionEvent(event: SessionEvent, state: MappingState): AguiEvent[] {
  const data: unknown = event.data
  // Plugin-merged event types (todo/write, approval/*) are not visible in the
  // installed SessionEventMap union — compare on the widened string.
  const type: string = event.type
  switch (type) {
    case 'step/start':
      return [{ type: 'STEP_STARTED', stepName: `step-${(data as { step: number }).step}` }]
    case 'step/end':
      return [{ type: 'STEP_FINISHED', stepName: `step-${(data as { step: number }).step}` }]
    case 'assistant/message': {
      const d = data as { message: { id: string; content: readonly ContentBlock[] }; stream: unknown }
      state.lastAssistantMessageId = d.message.id
      const text = assistantTextOf(d)
      if (text === '') return [] // pure tool-call turn: the calls carry the content
      return [
        { type: 'TEXT_MESSAGE_START', messageId: d.message.id, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: d.message.id, delta: text },
        { type: 'TEXT_MESSAGE_END', messageId: d.message.id },
      ]
    }
    case 'tool/call': {
      const d = data as { callId: string; name: string; arguments: string }
      return [
        { type: 'TOOL_CALL_START', toolCallId: d.callId, toolCallName: d.name, parentMessageId: state.lastAssistantMessageId },
        { type: 'TOOL_CALL_ARGS', toolCallId: d.callId, delta: d.arguments },
        { type: 'TOOL_CALL_END', toolCallId: d.callId },
      ]
    }
    case 'tool/result': {
      const d = data as { message: { id: string; toolCallId: string; content: readonly ContentBlock[] } }
      return [{
        type: 'TOOL_CALL_RESULT',
        messageId: d.message.id,
        toolCallId: d.message.toolCallId,
        content: contentText(d.message.content),
      }]
    }
    case 'todo/write':
      return [{ type: 'STATE_SNAPSHOT', snapshot: { todos: (data as { todos?: unknown }).todos ?? [] } }]
    // Approval audit events have no AG-UI counterpart — carried as CUSTOM so
    // clients can render an audit trail. The interactive pause itself is a
    // RUN_FINISHED interrupt outcome emitted by the approval capture (S3b-3).
    case 'approval/asked': {
      const d = data as { id?: string; toolName?: string; callId?: string; reason?: string }
      return [{ type: 'CUSTOM', name: 'hibuddy.approval.asked', value: d }]
    }
    case 'approval/decided': {
      const d = data as { id?: string; outcome?: string }
      return [{ type: 'CUSTOM', name: 'hibuddy.approval.decided', value: d }]
    }
    default:
      return []
  }
}
