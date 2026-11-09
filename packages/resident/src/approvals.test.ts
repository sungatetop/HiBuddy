import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { ApprovalBroker } from './approvals.ts'
import { MessageService } from './messages.ts'
import { Store } from './store.ts'

let dir: string
let store: Store
let messages: MessageService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-approvals-'))
  store = Store.open(dir)
  messages = new MessageService(store)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

type Handler = (req: ApprovalRequest, next: () => Promise<'unavailable'>) => Promise<string>

/** Installs the broker over a fake host context and returns the handler. */
function install(broker: ApprovalBroker): Handler {
  let handler: Handler | undefined
  const ctx = {
    on: (event: string, fn: Handler) => {
      if (event === 'approval/request') handler = fn
      return () => {}
    },
  } as unknown as Context
  broker.install(ctx)
  return handler!
}

function request(sessionId: string, reason: string): ApprovalRequest {
  return {
    agent: { session: { id: sessionId } } as unknown as Agent,
    toolName: 'write',
    reason,
  } as ApprovalRequest
}

function seedWorking(): void {
  store.upsertTicket({
    id: 't1',
    goal: '写文件',
    mandate: 'explicit',
    origin: 'butler',
    state: 'working',
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
  })
  store.upsertWorkerSession({ ticketId: 't1', sessionId: 'resident-worker-1', state: 'working' })
}

describe('ApprovalBroker', () => {
  it('passes foreign agents through untouched', async () => {
    const broker = new ApprovalBroker(store, messages)
    const handler = install(broker)
    expect(await handler(request('chat-session', 'anything'), async () => 'unavailable')).toBe('unavailable')
  })

  it('records a card + inbound event and waits for the butler decision', async () => {
    seedWorking()
    const broker = new ApprovalBroker(store, messages)
    const handler = install(broker)

    const decision = handler(request('resident-worker-1', 'tool needs permission'), async () => 'unavailable')
    await Promise.resolve()

    expect(store.getTicket('t1')!.state).toBe('awaiting_approval')
    const out = store.listMessages({ direction: 'out' })
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('approval')
    expect(out[0]!.refs?.ticketId).toBe('t1')
    const inbound = store.listMessages({ direction: 'in' })
    expect(inbound).toHaveLength(1)
    expect(broker.pendingApprovals()).toHaveLength(1)

    const id = broker.pendingApprovals()[0]!.id
    expect(broker.resolveApproval(id, true, 'butler')).toEqual({ ok: true })
    expect(await decision).toBe('allowed-once')
    expect(store.getTicket('t1')!.state).toBe('working')
    expect(broker.pendingApprovals()).toHaveLength(0)
  })

  it('refuses a butler decision on dangerous escalations until the user replied', async () => {
    seedWorking()
    const broker = new ApprovalBroker(store, messages)
    const handler = install(broker)

    void handler(request('resident-worker-1', 'escalate sandbox to danger-full-access'), async () => 'unavailable')
    await Promise.resolve()
    const id = broker.pendingApprovals()[0]!.id
    expect(broker.pendingApprovals()[0]!.requiresUser).toBe(true)

    const refused = broker.resolveApproval(id, true, 'butler')
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('用户确认')

    // The user's reply (a newer inbound text row) unlocks the butler decision.
    messages.postInbound({ kind: 'text', text: '同意这次写入' })
    expect(broker.resolveApproval(id, true, 'butler')).toEqual({ ok: true })
  })

  it('upgrades every approval to a user decision when delegation is off', async () => {
    seedWorking()
    store.setSetting('approvalDelegation', false)
    const broker = new ApprovalBroker(store, messages)
    const handler = install(broker)

    void handler(request('resident-worker-1', 'tool needs permission'), async () => 'unavailable')
    await Promise.resolve()
    const pending = broker.pendingApprovals()[0]!
    expect(pending.requiresUser).toBe(true)
    expect(broker.resolveApproval(pending.id, true, 'butler').ok).toBe(false)
  })

  it('fails closed on unknown ids', () => {
    const broker = new ApprovalBroker(store, messages)
    expect(broker.resolveApproval('apr_missing', true, 'butler').ok).toBe(false)
  })
})
