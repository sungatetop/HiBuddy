/**
 * Contract tests for the SessionEvent → AG-UI mapping layer (implementation-plan
 * S3b task 5: 事件映射). The mapper is the bridge's protocol surface — these
 * tests pin the ADR-009 §3.2 table so a dsh event-rename or an AG-UI shape
 * change fails loudly here instead of silently corrupting the wire.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mapSessionEvent, newMappingState, terminalOf } from './events.ts'

/** Minimal SessionEvent literal — the mapper reads only type/data. */
function ev(type: string, data: unknown): SessionEvent {
  return { type, data } as unknown as SessionEvent
}

describe('mapSessionEvent（ADR-009 §3.2 映射表）', () => {
  it('maps step lifecycle to STEP_STARTED/STEP_FINISHED with step-N names', () => {
    expect(mapSessionEvent(ev('step/start', { step: 2 }), newMappingState()))
      .toEqual([{ type: 'STEP_STARTED', stepName: 'step-2' }])
    expect(mapSessionEvent(ev('step/end', { step: 2 }), newMappingState()))
      .toEqual([{ type: 'STEP_FINISHED', stepName: 'step-2' }])
  })

  it('maps assistant/message to the TEXT_MESSAGE trio carrying the whole text as one delta', () => {
    const state = newMappingState()
    const events = mapSessionEvent(ev('assistant/message', {
      message: { id: 'm1', content: [{ type: 'text', text: '你好' }, { type: 'text', text: '！' }] },
      stream: [],
    }), state)
    expect(events).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '你好！' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
    ])
    expect(state.lastAssistantMessageId).toBe('m1')
  })

  it('prefers stream text-chunks over content blocks', () => {
    const events = mapSessionEvent(ev('assistant/message', {
      message: { id: 'm1', content: [{ type: 'text', text: 'fallback' }] },
      stream: [{ type: 'text-chunks', texts: ['stream', ' wins'] }],
    }), newMappingState())
    expect(events.find(e => e.type === 'TEXT_MESSAGE_CONTENT'))
      .toMatchObject({ delta: 'stream wins' })
  })

  it('emits nothing for a pure tool-call turn (no visible text)', () => {
    const events = mapSessionEvent(ev('assistant/message', {
      message: { id: 'm1', content: [] },
      stream: [],
    }), newMappingState())
    expect(events).toEqual([])
  })

  it('maps tool/call to the TOOL_CALL trio attributed to the last assistant message', () => {
    const state = newMappingState()
    mapSessionEvent(ev('assistant/message', {
      message: { id: 'm9', content: [{ type: 'text', text: 'working' }] },
      stream: [],
    }), state)
    const events = mapSessionEvent(ev('tool/call', {
      callId: 'c1', name: 'write', arguments: '{"path":"a.txt"}',
    }), state)
    expect(events).toEqual([
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'write', parentMessageId: 'm9' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"path":"a.txt"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
    ])
  })

  it('maps tool/result to TOOL_CALL_RESULT with visible text content', () => {
    const events = mapSessionEvent(ev('tool/result', {
      message: { id: 'm10', toolCallId: 'c1', content: [{ type: 'text', text: 'written' }] },
    }), newMappingState())
    expect(events).toEqual([
      { type: 'TOOL_CALL_RESULT', messageId: 'm10', toolCallId: 'c1', content: 'written' },
    ])
  })

  it('maps todo/write to a full STATE_SNAPSHOT', () => {
    const todos = [{ id: 't1', content: 'x', status: 'pending' }]
    expect(mapSessionEvent(ev('todo/write', { todos }), newMappingState()))
      .toEqual([{ type: 'STATE_SNAPSHOT', snapshot: { todos } }])
    expect(mapSessionEvent(ev('todo/write', {}), newMappingState()))
      .toEqual([{ type: 'STATE_SNAPSHOT', snapshot: { todos: [] } }])
  })

  it('maps approval audit events to CUSTOM carriers', () => {
    const asked = mapSessionEvent(ev('approval/asked', { id: 'a1', toolName: 'write', callId: 'c1' }), newMappingState())
    expect(asked).toEqual([{ type: 'CUSTOM', name: 'hibuddy.approval.asked', value: { id: 'a1', toolName: 'write', callId: 'c1' } }])
    const decided = mapSessionEvent(ev('approval/decided', { id: 'a1', outcome: 'allowed-once' }), newMappingState())
    expect(decided).toEqual([{ type: 'CUSTOM', name: 'hibuddy.approval.decided', value: { id: 'a1', outcome: 'allowed-once' } }])
  })

  it('drops events without an AG-UI counterpart (user echo, request headers, unknown)', () => {
    const state = newMappingState()
    expect(mapSessionEvent(ev('user/message', { message: {} }), state)).toEqual([])
    expect(mapSessionEvent(ev('request/header', { header: {} }), state)).toEqual([])
    expect(mapSessionEvent(ev('future/unknown', { x: 1 }), state)).toEqual([])
  })
})

describe('terminalOf（turn/end reason → 终态事件）', () => {
  it('maps completed and unknown plugin reasons to a plain RUN_FINISHED', () => {
    expect(terminalOf({ kind: 'completed' }, 't', 'r'))
      .toEqual({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' })
    expect(terminalOf({ kind: 'max-tokens' }, 't', 'r'))
      .toEqual({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' })
    expect(terminalOf(undefined, 't', 'r'))
      .toEqual({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' })
  })

  it('maps aborted/interrupted to RUN_FINISHED with cancelled outcome', () => {
    for (const kind of ['aborted', 'interrupted']) {
      expect(terminalOf({ kind }, 't', 'r'))
        .toEqual({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'cancelled' } })
    }
  })

  it('maps error to RUN_ERROR carrying message and optional code', () => {
    expect(terminalOf({ kind: 'error', error: { message: 'boom', code: 'E1' } }, 't', 'r'))
      .toEqual({ type: 'RUN_ERROR', message: 'boom', code: 'E1' })
    const noDetail = terminalOf({ kind: 'error', error: {} }, 't', 'r')
    expect(noDetail).toMatchObject({ type: 'RUN_ERROR', message: expect.stringContaining('turn failed') })
    const noErrorBody = terminalOf({ kind: 'error' }, 't', 'r')
    expect(noErrorBody).toMatchObject({ type: 'RUN_ERROR', message: expect.stringContaining('turn failed') })
  })

  it('maps blocked to RUN_ERROR with the blocked code', () => {
    expect(terminalOf({ kind: 'blocked' }, 't', 'r'))
      .toEqual({ type: 'RUN_ERROR', message: 'the turn ended blocked and cannot continue', code: 'blocked' })
  })
})
