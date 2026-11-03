/**
 * Approval capture for bridge-owned sessions (S3b-3, ADR-009 §3.3).
 *
 * dsh's approval waterfall suspends the turn on an in-flight answerer Promise.
 * For bridge-owned sessions the bridge IS the interactive answerer: it captures
 * the request as a pending entry, closes the open run with a
 * RUN_FINISHED interrupt outcome (AG-UI's "the run needs outside input" shape),
 * and answers when the client re-POSTs with ResumeEntry answers
 * (resolved → allowed-once, cancelled → cancelled). One-shot by design: the
 * bridge never infers a durable grant, and native-UI session grants never
 * reach here (the coworker answerer sits in front and short-circuits them).
 *
 * Non-bridge sessions pass straight through (`next()`), so the native Web UI's
 * approval flow is byte-for-byte unaffected by the bridge.
 */

import { randomUUID } from 'node:crypto'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { SessionRecord } from './sessions.ts'
import { detachActive } from './sessions.ts'

/** AG-UI interrupt reason constant for tool approvals. */
export const TOOL_APPROVAL_REASON = 'tool-approval'

/**
 * Capture one approval request for a bridge-owned session: register the
 * pending answer, terminate the open run with an interrupt outcome, and hold
 * the turn on the returned Promise until the client resumes.
 */
export function captureApproval(record: SessionRecord, req: { toolName: string; callId?: string; reason?: string }): Promise<ApprovalOutcome> {
  const interruptId = randomUUID()
  let resolveOutcome: (outcome: ApprovalOutcome) => void
  const promise = new Promise<ApprovalOutcome>((resolve) => {
    resolveOutcome = resolve
  })
  record.pendings.set(interruptId, {
    toolName: req.toolName,
    callId: req.callId,
    resolve: (outcome: ApprovalOutcome) => {
      record.pendings.delete(interruptId)
      resolveOutcome(outcome)
    },
  })

  const run = record.active
  if (run !== undefined) {
    run.sink.send({
      type: 'RUN_FINISHED',
      threadId: record.threadId,
      runId: run.runId,
      outcome: {
        type: 'interrupt',
        interrupts: [{
          id: interruptId,
          reason: TOOL_APPROVAL_REASON,
          message: req.reason ?? `工具 "${req.toolName}" 等待审批`,
          ...(req.callId === undefined ? {} : { toolCallId: req.callId }),
        }],
      },
    })
    run.sink.close()
    detachActive(record, run.runId)
  }
  // dsh's approval service owns this Promise; resolving it resumes the
  // suspended turn in place.
  return promise
}

/**
 * Answer captured pendings from a resume POST's ResumeEntry list.
 * Resolved entries → allowed-once; cancelled entries → cancelled; unknown
 * interrupt ids are ignored (the client may answer an interrupt the bridge
 * already dropped). Returns the number of pendings answered.
 */
export function answerPendings(record: SessionRecord, entries: readonly { interruptId: string; status: string }[]): number {
  let answered = 0
  for (const entry of entries) {
    const pending = record.pendings.get(entry.interruptId)
    if (pending === undefined) continue
    pending.resolve(entry.status === 'resolved' ? 'allowed-once' : 'cancelled')
    answered += 1
  }
  return answered
}

/** Cancel every pending approval of a record (session disposal path). */
export function cancelPendings(record: SessionRecord): void {
  for (const pending of [...record.pendings.values()]) {
    pending.resolve('cancelled')
  }
  record.pendings.clear()
}
