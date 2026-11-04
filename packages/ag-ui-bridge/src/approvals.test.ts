/**
 * Contract tests for the approval capture (implementation-plan S3b task 5:
 * 审批中断合成 + resume 决定回传). The interrupt shape is what AG-UI clients
 * render as an approval prompt and what `answerPendings` maps back to dsh
 * outcomes — these tests pin the RUN_FINISHED interrupt synthesis, the
 * resolved→allowed-once / cancelled→cancelled mapping, and the one-shot
 * lifecycle (unknown ids ignored, cancels sweep everything).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SseSink } from './sse.ts'
import type { AguiEvent } from './types.ts'
import type { SessionRecord } from './sessions.ts'
import { answerPendings, cancelPendings, captureApproval, TOOL_APPROVAL_REASON } from './approvals.ts'
import { newMappingState } from './events.ts'

/** Minimal bridge-owned record: only threadId/active/pendings are exercised. */
function makeRecord(): SessionRecord {
  return {
    sessionId: 'agui-test' as SessionId,
    threadId: 'test-thread',
    handle: {} as AgentHandle,
    active: undefined,
    pendings: new Map(),
  }
}

/** Recorder sink — captureApproval only send()s the interrupt and close()s. */
function makeSink() {
  return { send: vi.fn((_event: AguiEvent) => true), close: vi.fn() }
}

function activeRun(record: SessionRecord, runId = 'run-1'): void {
  record.active = { runId, sink: makeSink() as unknown as SseSink, mapper: newMappingState() }
}

describe('captureApproval（RUN_FINISHED interrupt 合成）', () => {
  it('closes the open run with an interrupt outcome and detaches it', () => {
    const record = makeRecord()
    activeRun(record)
    const sink = record.active!.sink as unknown as ReturnType<typeof makeSink>

    const pending = captureApproval(record, { toolName: 'write', callId: 'c1', reason: '工作区外写入' })

    expect(sink.send).toHaveBeenCalledTimes(1)
    const event = sink.send.mock.calls[0][0] as unknown as Record<string, unknown>
    expect(event.type).toBe('RUN_FINISHED')
    expect(event.threadId).toBe('test-thread')
    expect(event.runId).toBe('run-1')
    const outcome = event.outcome as { type: string; interrupts: Array<Record<string, unknown>> }
    expect(outcome.type).toBe('interrupt')
    expect(outcome.interrupts).toHaveLength(1)
    const interrupt = outcome.interrupts[0]
    expect(interrupt.reason).toBe(TOOL_APPROVAL_REASON)
    expect(interrupt.message).toBe('工作区外写入')
    expect(interrupt.toolCallId).toBe('c1')
    expect(typeof interrupt.id).toBe('string')
    expect(sink.close).toHaveBeenCalledTimes(1)
    expect(record.active).toBeUndefined()
    expect(record.pendings.size).toBe(1)
    expect(pending).toBeInstanceOf(Promise)
  })

  it('finishes an open step before RUN_FINISHED (strict-client invariant, S6-2)', () => {
    const record = makeRecord()
    activeRun(record)
    const { mapper, sink } = record.active! as unknown as { mapper: ReturnType<typeof newMappingState>; sink: ReturnType<typeof makeSink> }
    mapper.openStep = 'step-1'

    captureApproval(record, { toolName: 'write' })

    expect(sink.send).toHaveBeenCalledTimes(2)
    expect(sink.send.mock.calls[0][0]).toEqual({ type: 'STEP_FINISHED', stepName: 'step-1' })
    expect(sink.send.mock.calls[1][0]).toMatchObject({ type: 'RUN_FINISHED' })
    expect(mapper.openStep).toBeUndefined()
  })

  it('falls back to a tool-named message when no reason is given', () => {
    const record = makeRecord()
    activeRun(record)
    const sink = record.active!.sink as unknown as ReturnType<typeof makeSink>

    captureApproval(record, { toolName: 'write' })

    const event = sink.send.mock.calls[0][0] as unknown as Record<string, unknown>
    const interrupt = (event.outcome as { interrupts: Array<{ message: string }> }).interrupts[0]
    expect(interrupt.message).toContain('write')
    expect(interrupt.message).toContain('等待审批')
  })

  it('registers the pending even with no open run (resume path keeps working)', () => {
    const record = makeRecord()
    const promise = captureApproval(record, { toolName: 'write' })
    expect(record.pendings.size).toBe(1)
    expect(promise).toBeInstanceOf(Promise)
  })
})

describe('answerPendings（ResumeEntry → ApprovalOutcome 回传）', () => {
  it('maps resolved → allowed-once and removes the entry', async () => {
    const record = makeRecord()
    const promise = captureApproval(record, { toolName: 'write' })
    const [interruptId] = [...record.pendings.keys()]

    expect(answerPendings(record, [{ interruptId, status: 'resolved' }])).toBe(1)
    expect(record.pendings.size).toBe(0)
    await expect(promise).resolves.toBe('allowed-once')
  })

  it('maps cancelled → cancelled', async () => {
    const record = makeRecord()
    const promise = captureApproval(record, { toolName: 'write' })
    const [interruptId] = [...record.pendings.keys()]

    expect(answerPendings(record, [{ interruptId, status: 'cancelled' }])).toBe(1)
    await expect(promise).resolves.toBe('cancelled')
  })

  it('ignores unknown interrupt ids and leaves their promises pending', () => {
    const record = makeRecord()
    const promise = captureApproval(record, { toolName: 'write' })

    expect(answerPendings(record, [{ interruptId: 'no-such-id', status: 'resolved' }])).toBe(0)
    expect(record.pendings.size).toBe(1)
    // The captured approval stays captured: the turn is still suspended.
    expect(promise).toBeInstanceOf(Promise)
  })

  it('answers several pendings in one resume', async () => {
    const record = makeRecord()
    const p1 = captureApproval(record, { toolName: 'write' })
    const p2 = captureApproval(record, { toolName: 'edit' })
    const [id1, id2] = [...record.pendings.keys()]

    expect(answerPendings(record, [
      { interruptId: id1, status: 'resolved' },
      { interruptId: id2, status: 'cancelled' },
    ])).toBe(2)
    await expect(p1).resolves.toBe('allowed-once')
    await expect(p2).resolves.toBe('cancelled')
  })
})

describe('cancelPendings（会话销毁路径）', () => {
  it('resolves every pending cancelled and clears the map', async () => {
    const record = makeRecord()
    const p1 = captureApproval(record, { toolName: 'write' })
    const p2 = captureApproval(record, { toolName: 'edit' })

    cancelPendings(record)
    expect(record.pendings.size).toBe(0)
    await expect(p1).resolves.toBe('cancelled')
    await expect(p2).resolves.toBe('cancelled')
  })

  it('is safe on a record with no pendings', () => {
    const record = makeRecord()
    expect(() => cancelPendings(record)).not.toThrow()
  })
})
