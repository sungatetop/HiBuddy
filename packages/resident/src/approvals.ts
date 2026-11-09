/**
 * Approval broker (ADR-011 D9): routes worker approvals into the butler
 * conversation instead of a UI takeover.
 *
 * The dsh approval seam is a waterfall — an answerer registered on
 * `approval/request` decides. This broker answers ONLY for resident worker
 * sessions: it writes an approval card (out/approval) plus an inbound approval
 * event for the butler, then waits for the butler's `resolve_approval` call
 * (or the user's explicit confirmation for dangerous escalations). Every other
 * agent's approval falls through to the existing answerers untouched.
 *
 * Safety: dangerous escalations (`danger-full-access`, sandbox escalation)
 * are marked `requiresUser`; the broker refuses a butler resolution unless a
 * user text row arrived AFTER the card — the butler must ask first. An
 * unanswered approval is closed as `rejected` after a long timeout so a
 * forgotten worker cannot hang forever.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Message } from './domain.ts'
import type { MessageService } from './messages.ts'
import { transitionTicket } from './state-machine.ts'
import type { Store } from './store.ts'

/** Longest a worker approval may stay pending before failing closed. */
const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000

/** Reasons that must be confirmed by the user, never the butler alone. */
const DANGEROUS = /danger-full-access|escalate\s+sandbox|sandbox/i

/** One approval waiting for a decision. */
export interface PendingApproval {
  id: string
  ticketId?: string
  sessionId: string
  toolName: string
  reason: string
  requiresUser: boolean
  createdAt: string
}

interface Pending extends PendingApproval {
  agent: Agent
  settle: (outcome: 'allowed-once' | 'rejected') => void
}

/** The butler-facing approval surface. */
export interface ApprovalBrokerFace {
  pendingApprovals(): PendingApproval[]
  resolveApproval(id: string, approved: boolean, by: 'butler'): { ok: boolean; error?: string }
}

export class ApprovalBroker implements ApprovalBrokerFace {
  private readonly store: Store
  private readonly messages: MessageService
  private readonly pending = new Map<string, Pending>()

  constructor(store: Store, messages: MessageService) {
    this.store = store
    this.messages = messages
  }

  /** Installs the answerer at the front of the chain (before coworker grading). */
  install(ctx: Context): () => void {
    return ctx.on(
      'approval/request',
      (req: ApprovalRequest, next: () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>) => {
        const sessionId = String(req.agent.session.id)
        if (!sessionId.startsWith('resident-worker-')) return next()
        return this.ask(req, sessionId)
      },
      { prepend: true },
    )
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.pending.values()].map(({ agent: _agent, settle: _settle, ...rest }) => rest)
  }

  /**
   * The butler's decision. Dangerous escalations require a user text row newer
   * than the card (the butler must have asked and the user must have replied).
   */
  resolveApproval(id: string, approved: boolean, by: 'butler'): { ok: boolean; error?: string } {
    const record = this.pending.get(id)
    if (record === undefined) return { ok: false, error: `unknown or settled approval ${id}` }
    if (by === 'butler' && record.requiresUser) {
      const replied = this.store
        .listMessages({ direction: 'in', limit: 50 })
        .some((message) => message.kind === 'text' && message.createdAt > record.createdAt)
      if (!replied) {
        return { ok: false, error: '高危动作需要用户确认：先用 send_message_to_user 提问并等待用户回复' }
      }
    }
    this.pending.delete(id)
    record.settle(approved ? 'allowed-once' : 'rejected')
    return { ok: true }
  }

  /** Answerer body: record the card + event, then await the decision. */
  private async ask(req: ApprovalRequest, sessionId: string): Promise<'allowed-once' | 'rejected'> {
    const worker = this.store.listWorkerSessions().find((row) => row.sessionId === sessionId)
    const ticketId = worker?.ticketId
    const ticket = ticketId !== undefined ? this.store.getTicket(ticketId) : undefined
    if (ticket !== undefined && ticket.state === 'working') {
      transitionTicket(this.store, ticket, 'awaiting_approval')
    }
    if (worker !== undefined) {
      this.store.upsertWorkerSession({ ...worker, state: 'awaiting_approval' })
    }

    const id = `apr_${randomUUID()}`
    const reason = req.reason?.trim() || `${req.toolName} 需要授权`
    // Delegation off (settings `approvalDelegation: false`) upgrades EVERY
    // approval to a user decision; dangerous reasons always do (ADR-011 D9).
    const delegationOff = this.store.getSetting<boolean>('approvalDelegation') === false
    const requiresUser = delegationOff || DANGEROUS.test(reason) || DANGEROUS.test(req.toolName)
    const now = new Date().toISOString()
    const refs: Message['refs'] = { ...(ticketId !== undefined ? { ticketId } : {}), sessionId }

    this.messages.postOutbound({
      kind: 'approval',
      refs,
      idempotencyKey: `approval:${id}`,
      title: `需要审批：${req.toolName}`,
      text: `${reason}\n审批编号：${id}`,
    })
    this.messages.postInbound({
      kind: 'approval',
      refs,
      idempotencyKey: `approval-event:${id}`,
      text:
        `worker 发起了审批请求（编号 ${id}，工具 ${req.toolName}）：${reason}\n` +
        (requiresUser
          ? '这是高危动作：必须先用 send_message_to_user（kind=question）向用户确认，收到用户回复后才能调用 resolve_approval。'
          : '你可以在代管范围内用 resolve_approval 决定，或先询问用户。'),
    })

    return await new Promise<'allowed-once' | 'rejected'>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        resolve('rejected')
        console.warn(`[hibbuddy-resident] approval ${id} timed out; failed closed`)
      }, APPROVAL_TIMEOUT_MS)
      timer.unref?.()
      this.pending.set(id, {
        id,
        ...(ticketId !== undefined ? { ticketId } : {}),
        sessionId,
        toolName: req.toolName,
        reason,
        requiresUser,
        createdAt: now,
        agent: req.agent,
        settle: (outcome) => {
          clearTimeout(timer)
          resolve(outcome)
          this.afterDecision(sessionId, ticketId, outcome)
        },
      })
    })
  }

  /** Restore the ticket/worker state after a decision (rejection included). */
  private afterDecision(
    sessionId: string,
    ticketId: string | undefined,
    outcome: 'allowed-once' | 'rejected',
  ): void {
    const worker = this.store.listWorkerSessions().find((row) => row.sessionId === sessionId)
    if (worker !== undefined) this.store.upsertWorkerSession({ ...worker, state: 'working' })
    if (ticketId === undefined) return
    const ticket = this.store.getTicket(ticketId)
    if (ticket !== undefined && ticket.state === 'awaiting_approval') {
      transitionTicket(this.store, ticket, 'working', {
        summary: outcome === 'allowed-once' ? '审批通过，继续执行' : '审批被拒绝，worker 继续处理',
      })
    }
  }
}
