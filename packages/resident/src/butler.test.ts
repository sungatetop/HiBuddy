import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { BUTLER_PRESET_ID, BUTLER_SESSION_ID, ButlerRuntime, renderInbound, type ButlerDeps } from './butler.ts'
import { MessageService } from './messages.ts'
import { Store } from './store.ts'

let dir: string
let store: Store

/** Fake agent capturing every followup text. */
function fakeAgent(options: { live?: boolean } = {}) {
  const followups: string[] = []
  const agent = {
    session: { seq: 0, snapshotEvents: () => [] },
    status: 'idle',
    whenIdle: async () => {},
    followup: (message: { content: Array<{ type: string; text?: string }> }) => {
      const text = message.content.map((block) => block.text ?? '').join('')
      followups.push(text)
    },
    cancel: () => {},
  } as unknown as Agent
  return { agent, followups }
}

function fakeDeps(options: { live?: boolean; events?: () => void; workspaces?: Array<{ id: string; path: string; title: string }> } = {}): ButlerDeps & {
  created: CreateAgentOptions[]
  liveAgent?: Agent
  liveFollowups: string[]
} {
  const created: CreateAgentOptions[] = []
  const live = options.live === true ? fakeAgent() : undefined
  const ctx = {
    on: () => () => {},
    get: (name: string) =>
      name === 'workspaceRegistry'
        ? { list: () => options.workspaces ?? [] }
        : undefined,
  } as unknown as Context
  const agents = {
    get: (id: string) =>
      options.live === true && (id === BUTLER_SESSION_ID || id === 'resident-worker-t1')
        ? live?.agent
        : undefined,
    create: async (opts: CreateAgentOptions) => {
      created.push(opts)
      const fresh = fakeAgent()
      return { agent: fresh.agent, dispose: async () => {} } as AgentHandle
    },
    resume: async () => ({ agent: fakeAgent().agent, dispose: async () => {} }) as AgentHandle,
  } as unknown as AgentRegistry
  return {
    ctx,
    agents,
    presets: {
      resolve: async () => ({ id: BUTLER_PRESET_ID }),
      mount: async () => ({}),
    } as unknown as AgentPresetRegistry,
    defaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    } as unknown as AgentDefaultModelConfig,
    created,
    liveAgent: live?.agent,
    liveFollowups: live?.followups ?? [],
  }
}

function makeRuntime(deps: ButlerDeps, messages?: MessageService) {
  const service = messages ?? new MessageService(store, { onInbound: () => runtime.wake() })
  const runtime = new ButlerRuntime(deps, store, service)
  return { runtime, service }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-butler-'))
  store = Store.open(dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('start', () => {
  it('creates the butler session with the small preset and records its state', async () => {
    const deps = fakeDeps()
    const { runtime } = makeRuntime(deps)
    await runtime.start()

    expect(deps.created).toHaveLength(1)
    expect(deps.created[0]!.sessionId).toBe(BUTLER_SESSION_ID)
    expect(deps.created[0]!.meta?.agentPreset).toBe(BUTLER_PRESET_ID)
    expect(store.getButlerState()?.sessionId).toBe(BUTLER_SESSION_ID)
  })

  it('resumes a persisted butler session instead of opening a new one', async () => {
    store.upsertButlerState({ sessionId: BUTLER_SESSION_ID, state: 'idle' })
    const deps = fakeDeps()
    const { runtime } = makeRuntime(deps)
    await runtime.start()
    expect(deps.created).toHaveLength(0)
  })
})

describe('turn pump', () => {
  it('consumes inbound rows one batch per turn and wakes only when work exists', async () => {
    const deps = fakeDeps({ live: true })
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    runtime.postUserMessage('帮我把下载目录整理一下')
    await vi.waitFor(() => expect(deps.liveFollowups).toHaveLength(1))
    expect(deps.liveFollowups[0]).toContain('帮我把下载目录整理一下')
    await vi.waitFor(() => expect(service.pendingInbound()).toHaveLength(0))

    // No new inbound → no extra turn.
    runtime.wake()
    expect(deps.liveFollowups).toHaveLength(1)
  })

  it('feeds event envelopes and receipts as framed inbound turns', () => {
    expect(
      renderInbound([
        { id: '1', direction: 'in', kind: 'text', text: 'hi', idempotencyKey: 'k', read: false, delivered: true, createdAt: '' },
        { id: '2', direction: 'in', kind: 'receipt', text: '完成', idempotencyKey: 'k2', read: false, delivered: true, createdAt: '' },
      ]),
    ).toContain('【任务回执】完成')
  })
})

describe('delegation surface', () => {
  it('create_session writes a pending ticket with a deterministic worker session id', async () => {
    const deps = fakeDeps({ live: true })
    const { runtime } = makeRuntime(deps)
    await runtime.start()

    const created = runtime.createSession({ goal: '整理下载目录' })
    const ticket = store.getTicket(created.ticketId)!
    expect(ticket).toMatchObject({ goal: '整理下载目录', state: 'pending', mandate: 'explicit', origin: 'butler' })
    expect(ticket.nextRunAt).not.toBeNull()
    expect(created.sessionId.startsWith('resident-worker-')).toBe(true)
  })

  it('send_to_session forwards to a live worker; unknown ids fail closed', async () => {
    const deps = fakeDeps({ live: true })
    const { runtime } = makeRuntime(deps)
    await runtime.start()

    expect(runtime.sendToSession('resident-worker-t1', '补充约束').ok).toBe(true)
    expect(deps.liveFollowups.at(-1)).toContain('补充约束')
    const missing = runtime.sendToSession('resident-worker-missing', 'x')
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('not live')
  })

  it('cancel_session stops the ticket and cancels the agent', async () => {
    const deps = fakeDeps({ live: true })
    const { runtime } = makeRuntime(deps)
    await runtime.start()

    const created = runtime.createSession({ goal: '跑一个长任务' })
    store.upsertWorkerSession({
      ticketId: created.ticketId,
      sessionId: created.sessionId,
      state: 'working',
    })
    // The scheduler would move it working; simulate that state.
    store.upsertTicket({ ...store.getTicket(created.ticketId)!, state: 'working' })

    expect(runtime.cancelSession(created.sessionId).ok).toBe(true)
    expect(store.getTicket(created.ticketId)!.state).toBe('stopped')

    const listed = runtime.listSessions()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.sessionId).toBe(created.sessionId)
  })
})

describe('workspaces', () => {
  const workspaces = [
    { id: 'w1', path: 'D:\\ProjectA', title: 'ProjectA' },
    { id: 'w2', path: 'D:\\ProjectB', title: 'ProjectB' },
  ]

  it('binds the butler session to the first registered workspace', async () => {
    const deps = fakeDeps({ workspaces })
    const { runtime } = makeRuntime(deps)
    await runtime.start()

    expect(deps.created[0]!.meta?.cwd).toBe('D:\\ProjectA')
  })

  it('resolves a workspace by id, title, or path and persists it on the ticket', () => {
    const deps = fakeDeps({ workspaces })
    const { runtime } = makeRuntime(deps)

    expect(runtime.listWorkspaces()).toHaveLength(2)
    const byTitle = runtime.createSession({ goal: 'g1', workspace: 'ProjectB' })
    expect(byTitle.workspace).toBe('D:\\ProjectB')
    expect(store.getTicket(byTitle.ticketId)!.workspace).toBe('D:\\ProjectB')

    const byId = runtime.createSession({ goal: 'g2', workspace: 'w1' })
    expect(byId.workspace).toBe('D:\\ProjectA')

    const byPath = runtime.createSession({ goal: 'g3', workspace: 'd:\\projectb' })
    expect(byPath.workspace).toBe('D:\\ProjectB')
  })

  it('defaults to the first workspace and rejects an unknown one', () => {
    const deps = fakeDeps({ workspaces })
    const { runtime } = makeRuntime(deps)

    expect(runtime.createSession({ goal: 'g' }).workspace).toBe('D:\\ProjectA')
    expect(() => runtime.createSession({ goal: 'g', workspace: 'Nope' })).toThrow(/unknown workspace/)
  })
})

describe('sendMessage', () => {
  it('writes an outbound ledger row and does not dedupe repeated text', async () => {
    const deps = fakeDeps({ live: true })
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    const first = runtime.sendMessage({ text: '收到', kind: 'text' })
    const second = runtime.sendMessage({ text: '收到', kind: 'text' })
    expect(first.recorded).toBe(true)
    expect(second.recorded).toBe(true)
    expect(service.list({ direction: 'out' })).toHaveLength(2)
  })

  it('records a session link on the outbound row when the message is about a worker', async () => {
    const deps = fakeDeps({ live: true })
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    runtime.sendMessage({ text: '已开始分析', kind: 'report', sessionId: 'resident-worker-t1' })

    const stored = service.list({ direction: 'out' })[0]!
    expect(stored.refs?.sessionId).toBe('resident-worker-t1')
  })

  it('records a workspace file attachment on the outbound row', async () => {
    const deps = fakeDeps({ live: true, workspaces: [{ id: 'w1', path: dir, title: 'W' }] })
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()
    const file = join(dir, 'chart.png')
    writeFileSync(file, Buffer.alloc(8))

    runtime.sendMessage({ text: '图表如下', kind: 'report', attachments: [{ path: file }] })

    const stored = service.list({ direction: 'out' })[0]!
    expect(stored.attachments).toHaveLength(1)
    expect(stored.attachments![0]).toMatchObject({ kind: 'image', name: 'chart.png', size: 8 })
    expect(runtime.attachment(stored.attachments![0]!.id)).toMatchObject({ messageId: stored.id })
  })

  it('rejects attachments outside the registered workspaces', async () => {
    const deps = fakeDeps({ live: true, workspaces: [{ id: 'w1', path: dir, title: 'W' }] })
    const { runtime } = makeRuntime(deps)
    await runtime.start()

    expect(() =>
      runtime.sendMessage({ text: 'x', kind: 'text', attachments: [{ path: 'C:\\Windows\\win.ini' }] }),
    ).toThrow(/不在任何工作区/)
  })
})

describe('settings', () => {
  it('returns the panel defaults and round-trips an explicit patch', () => {
    const deps = fakeDeps()
    const { runtime } = makeRuntime(deps)

    expect(runtime.settings()).toMatchObject({ workerSlots: 2, observeMode: true, approvalDelegation: true })

    const saved = runtime.saveSettings({
      quietHours: { start: '22:30', end: '07:00' },
      workerSlots: 4,
      observeMode: false,
      approvalDelegation: false,
    })
    expect(saved.quietHours).toEqual({ start: '22:30', end: '07:00' })
    expect(saved.workerSlots).toBe(4)
    expect(saved.observeMode).toBe(false)
    expect(saved.approvalDelegation).toBe(false)
    expect(runtime.settings()).toEqual(saved)
  })

  it('rejects malformed quiet windows and clamps the worker slots', () => {
    const deps = fakeDeps()
    const { runtime } = makeRuntime(deps)

    const saved = runtime.saveSettings({
      quietHours: { start: '99:00', end: '07:00' },
      workerSlots: 99,
    })
    expect(saved.quietHours).toBeNull()
    expect(saved.workerSlots).toBe(8)
  })
})
