/**
 * Run-timeline derivation (FR-08, S5-2): turn grouping, tool result join,
 * terminal status projection, human-prompt capture, decision mirror join,
 * and transient-row skipping.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  deriveRunTimelines,
  runStallMs,
  RUN_RESULT_LIMIT,
  STALL_THRESHOLD_MS,
  SUMMARY_LIMIT,
  summarizeRun,
} from './derive.ts'
import type { ApprovalDecisionRecord } from './decisions.ts'

let seq = 0

/** Fabricate one durable event entry shaped like the window's rows. */
function ev(type: string, data: Record<string, unknown>, time = 1000): SessionEventLikeEntry {
  return { type: 'event', event: { type, seq: ++seq, time, data } } as unknown as SessionEventLikeEntry
}

/** Fabricate one transient (live chunk) entry — never a timeline fact. */
function transient(time = 1000): SessionEventLikeEntry {
  return {
    type: 'transient',
    event: { type: 'assistant/chunk', seq: ++seq, time, data: {} },
  } as unknown as SessionEventLikeEntry
}

const HUMAN = { source: { kind: 'user' }, content: [{ type: 'text', text: '画一个登录页' }] }
const SYNTHETIC = { source: { kind: 'agent' }, content: [{ type: 'text', text: '[shared-state update]' }] }

describe('deriveRunTimelines', () => {
  it('derives one completed run with prompt, tool row, and tokened output', () => {
    seq = 0
    const runs = deriveRunTimelines([
      ev('turn/start', { turn: 1 }, 1_000),
      ev('user/message', HUMAN, 1_100),
      ev('step/start', { turn: 1, step: 1 }, 1_200),
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'render_ui', arguments: '{"instruction":{}}' }, 1_300),
      ev('tool/result', { message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok rendered' }] } }, 1_500),
      ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '画好了' }] }, usage: { outputTokens: 42 } }, 1_600),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_700),
    ])
    expect(runs).toHaveLength(1)
    const run = runs[0]
    expect(run.turn).toBe(1)
    expect(run.status).toEqual({ kind: 'completed' })
    expect(run.endedAt).toBe(1_700)
    expect(run.prompt).toBe('画一个登录页')
    const tool = run.items.find((item) => item.kind === 'tool')
    expect(tool).toMatchObject({
      kind: 'tool',
      callId: 'c1',
      name: 'render_ui',
      argsRaw: '{"instruction":{}}',
      status: 'ok',
      durationMs: 200,
      resultSummary: 'ok rendered',
    })
    const output = run.items.find((item) => item.kind === 'output')
    expect(output).toMatchObject({ kind: 'output', text: '画好了', outputTokens: 42 })
  })

  it('joins an error result (isError + failure reason) and the error end reason', () => {
    seq = 0
    const runs = deriveRunTimelines([
      ev('turn/start', { turn: 2 }, 2_000),
      ev('user/message', HUMAN, 2_100),
      ev('tool/call', { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '"rm -rf"' }, 2_200),
      ev('tool/result', { message: { toolCallId: 'c2', isError: true, content: [] }, error: { reason: 'denied by grading' } }, 2_300),
      ev('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'llm boom', code: 'X' } } }, 2_400),
    ])
    const run = runs[0]
    expect(run.status).toEqual({ kind: 'error', message: 'llm boom' })
    const tool = run.items.find((item) => item.kind === 'tool')
    expect(tool).toMatchObject({ status: 'error', errorReason: 'denied by grading' })
  })

  it('captures the human prompt only (synthetic injections stay out)', () => {
    seq = 0
    const runs = deriveRunTimelines([
      ev('turn/start', { turn: 3 }, 3_000),
      ev('user/message', SYNTHETIC, 3_050),
      ev('user/message', HUMAN, 3_100),
      ev('turn/end', { turn: 3, reason: { kind: 'completed' } }, 3_200),
    ])
    expect(runs[0].prompt).toBe('画一个登录页')
    expect(runs[0].items.some((item) => item.kind === 'prompt' && item.text === '[shared-state update]')).toBe(false)
  })

  it('joins card decisions onto tool rows by callId', () => {
    seq = 0
    const decision: ApprovalDecisionRecord = { decision: 'rejected', toolName: 'bash', at: 2_250 }
    const runs = deriveRunTimelines(
      [
        ev('turn/start', { turn: 4 }, 2_000),
        ev('tool/call', { turn: 4, step: 1, callId: 'c4', name: 'bash', arguments: '"ls"' }, 2_200),
        ev('tool/result', { message: { toolCallId: 'c4', isError: true, content: [] } }, 2_300),
        ev('turn/end', { turn: 4, reason: { kind: 'completed' } }, 2_400),
      ],
      new Map([['c4', decision]]),
    )
    const tool = runs[0].items.find((item) => item.kind === 'tool')
    expect(tool).toMatchObject({ kind: 'tool', decision })
  })

  it('groups multiple turns into ordered runs and leaves the open one running', () => {
    seq = 0
    const runs = deriveRunTimelines([
      ev('turn/start', { turn: 5 }, 5_000),
      ev('turn/end', { turn: 5, reason: { kind: 'completed' } }, 5_100),
      ev('turn/start', { turn: 6 }, 5_200),
      ev('user/message', HUMAN, 5_300),
    ])
    expect(runs.map((run) => run.turn)).toEqual([5, 6])
    expect(runs[0].status).toEqual({ kind: 'completed' })
    expect(runs[1].status).toEqual({ kind: 'running' })
  })

  it('skips transient rows and clamps the prompt to the display bound', () => {
    seq = 0
    const long = '字'.repeat(1_000)
    const runs = deriveRunTimelines([
      transient(6_000),
      ev('turn/start', { turn: 7 }, 6_000),
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: long }] }, 6_100),
      ev('turn/end', { turn: 7, reason: { kind: 'completed' } }, 6_200),
    ])
    expect(runs[0].prompt.length).toBe(401) // 400 chars + ellipsis
    expect(runs[0].prompt.endsWith('…')).toBe(true)
    expect(SUMMARY_LIMIT).toBe(1_200)
  })
})

describe('summarizeRun / runStallMs (FR-02)', () => {
  it('summarizes goal, final result, tool stats, and ended duration', () => {
    seq = 0
    const [run] = deriveRunTimelines([
      ev('turn/start', { turn: 12 }, 1_000),
      ev('user/message', HUMAN, 1_100),
      ev('tool/call', { turn: 12, step: 1, callId: 'c12', name: 'bash', arguments: '"ls"' }, 1_200),
      ev('tool/result', { message: { toolCallId: 'c12', isError: false, content: [{ type: 'text', text: 'a.txt' }] } }, 1_400),
      ev('tool/call', { turn: 12, step: 2, callId: 'c13', name: 'bash', arguments: '"rm"' }, 1_500),
      ev('tool/result', { message: { toolCallId: 'c13', isError: true, content: [] } }, 1_600),
      ev('assistant/message', { turn: 12, step: 2, message: { content: [{ type: 'text', text: '完成' }] } }, 1_700),
      ev('turn/end', { turn: 12, reason: { kind: 'completed' } }, 1_800),
    ])
    const summary = summarizeRun(run, 99_000)
    expect(summary.goal).toBe('画一个登录页')
    expect(summary.result).toBe('完成')
    expect(summary.tools).toEqual({ total: 2, ok: 1, error: 1, running: 0 })
    expect(summary.durationMs).toBe(800) // endedAt - startedAt, unaffected by `now`
  })

  it('keeps the last non-empty output clamped to one line and uses now while running', () => {
    seq = 0
    const [run] = deriveRunTimelines([
      ev('turn/start', { turn: 13 }, 1_000),
      ev('assistant/message', { turn: 13, step: 1, message: { content: [{ type: 'text', text: '初稿' }] } }, 1_100),
      ev('assistant/message', { turn: 13, step: 2, message: { content: [{ type: 'text', text: '字'.repeat(300) }] } }, 1_200),
    ])
    const summary = summarizeRun(run, 5_000)
    expect(summary.result.length).toBe(RUN_RESULT_LIMIT + 1) // 200 chars + ellipsis
    expect(summary.result.endsWith('…')).toBe(true)
    expect(summary.durationMs).toBe(4_000) // now - startedAt while still open
  })

  it('measures stall from the last event while running and reports 0 once finished', () => {
    seq = 0
    const [finished, open] = deriveRunTimelines([
      ev('turn/start', { turn: 14 }, 1_000),
      ev('turn/end', { turn: 14, reason: { kind: 'completed' } }, 2_000),
      ev('turn/start', { turn: 15 }, 3_000),
      ev('user/message', HUMAN, 3_500),
    ])
    expect(STALL_THRESHOLD_MS).toBe(120_000)
    expect(runStallMs(finished, 5_000)).toBe(0)
    expect(runStallMs(open, 5_000)).toBe(1_500) // now - last event (user/message at 3_500)
  })
})
