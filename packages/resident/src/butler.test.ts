import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { BUTLER_PRESET_ID, BUTLER_SESSION_ID, ButlerRuntime, renderInbound, type ButlerDeps } from './butler.ts'
import { RevisionRegistry } from '@hibuddy/web-ui/genui-schema'
import type { Message } from './domain.ts'
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

function fakeDeps(options: {
  live?: boolean
  events?: () => void
  workspaces?: Array<{ id: string; path: string; title: string }>
  revisions?: RevisionRegistry
} = {}): ButlerDeps & {
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
        : name === 'hibuddy-genui-revisions'
          ? options.revisions
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

describe('transcript paging', () => {
  const row = (id: string, kind: Message['kind'], direction: Message['direction'], minute: number): Message => ({
    id,
    direction,
    kind,
    title: kind === 'event' ? undefined : '标题',
    text: `内容 ${id}`,
    idempotencyKey: `k-${id}`,
    read: false,
    delivered: false,
    createdAt: `2026-11-05T00:${String(minute).padStart(2, '0')}:00.000Z`,
  })

  it('pages visible rows backwards with hasMore, probing past hidden event rows', async () => {
    const deps = fakeDeps()
    const { runtime } = makeRuntime(deps)
    await runtime.start()

    // Four visible rows with one hidden event row between v2 and v3.
    store.addMessage(row('v1', 'text', 'in', 0))
    store.addMessage(row('v2', 'report', 'out', 1))
    store.addMessage(row('e1', 'event', 'in', 2))
    store.addMessage(row('v3', 'approval', 'out', 3))
    store.addMessage(row('v4', 'text', 'in', 4))

    // Limit-1 windows force the probe to cross the hidden event row: each
    // page must answer hasMore from *visible* rows, not raw ledger rows.
    const page1 = runtime.messages(1)
    expect(page1.messages.map((m) => m.id)).toEqual(['v4'])
    expect(page1.hasMore).toBe(true)

    const page2 = runtime.messages(1, page1.messages[0]!.id)
    expect(page2.messages.map((m) => m.id)).toEqual(['v3'])
    expect(page2.hasMore).toBe(true)

    const page3 = runtime.messages(1, page2.messages[0]!.id)
    expect(page3.messages.map((m) => m.id)).toEqual(['v2'])
    expect(page3.hasMore).toBe(true)

    const page4 = runtime.messages(1, page3.messages[0]!.id)
    expect(page4.messages.map((m) => m.id)).toEqual(['v1'])
    expect(page4.hasMore).toBe(false)
  })

  it('keeps pages disjoint when the walk crosses the raw 400-row page boundary', async () => {
    const deps = fakeDeps()
    const { runtime } = makeRuntime(deps)
    await runtime.start()

    // 402 hidden event rows older than four visible rows: the newest raw
    // page cannot hold every visible row, so the walk must continue from
    // the page's OLDEST row (regression: cursoring from the newest row
    // re-read the page and duplicated rows).
    const bulk = store.db.prepare(
      `INSERT INTO messages (id, direction, kind, text, idempotency_key, read, delivered, created_at)
       VALUES (?, 'in', 'event', 'e', ?, 1, 1, ?)`,
    )
    store.transaction(() => {
      for (let i = 0; i < 402; i++) {
        bulk.run(`e${String(i).padStart(4, '0')}`, `k-e${i}`, `2026-11-05T00:00:${String(i % 60).padStart(2, '0')}.000Z`)
      }
    })
    store.addMessage(row('v1', 'text', 'in', 0))
    store.addMessage(row('v2', 'report', 'out', 1))
    store.addMessage(row('v3', 'approval', 'out', 2))
    store.addMessage(row('v4', 'text', 'in', 3))

    const page1 = runtime.messages(2)
    expect(page1.messages.map((m) => m.id)).toEqual(['v3', 'v4'])
    expect(page1.hasMore).toBe(true)

    const page2 = runtime.messages(2, page1.messages[0]!.id)
    expect(page2.messages.map((m) => m.id)).toEqual(['v1', 'v2'])
    expect(page2.hasMore).toBe(false)
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
    ).toContain('【任务回执｜刚刚】')
  })

  it('prepends the situation snapshot and notes the remaining backlog (D2)', async () => {
    const deps = fakeDeps({ live: true })
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    // More rows than one batch: the first turn must see the full queue and the
    // backlog hint; the pump drains the rest in a second batch.
    for (let i = 0; i < 25; i++) service.postInbound({ kind: 'text', text: `msg ${i}` })
    await vi.waitFor(() => expect(deps.liveFollowups.length).toBeGreaterThanOrEqual(2))

    expect(deps.liveFollowups[0]).toContain('【当前情境｜')
    expect(deps.liveFollowups[0]).toContain('入站队列：25 条待处理')
    expect(deps.liveFollowups[0]).toContain('还有 5 条待处理')
    expect(deps.liveFollowups[0]).toContain('msg 0')
    await vi.waitFor(() => expect(service.pendingInbound()).toHaveLength(0))
  })
})

describe('ui send-back gate (genui-agui-optimization.md G2)', () => {
  /** Well-formed send-back envelope per the G2 contract. */
  const envelope = (id: string, revision: number): string =>
    `@[ui:${id}:${revision}] ${JSON.stringify({ component: 'form', event: 'submit', payload: { city: '杭州' } })}`

  function depsWithRegistry(revision: number): ButlerDeps & { liveFollowups: string[] } {
    const registry = new RevisionRegistry()
    registry.record(BUTLER_SESSION_ID, 'sales-form', revision)
    return fakeDeps({ live: true, revisions: registry })
  }

  it('delivers a current-revision send-back to the model', async () => {
    const deps = depsWithRegistry(3)
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    runtime.postUserMessage(envelope('sales-form', 3))
    await vi.waitFor(() => expect(deps.liveFollowups).toHaveLength(1))
    expect(deps.liveFollowups[0]).toContain('sales-form')
    expect(deps.liveFollowups[0]).toContain('杭州')
    await vi.waitFor(() => expect(service.pendingInbound()).toHaveLength(0))
    expect(service.list({ direction: 'out' })).toHaveLength(0)
  })

  it('rejects a stale revision: never feeds the model, posts a visible notice', async () => {
    const deps = depsWithRegistry(3)
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    runtime.postUserMessage(envelope('sales-form', 2))
    await vi.waitFor(() => expect(service.pendingInbound()).toHaveLength(0))
    expect(deps.liveFollowups).toHaveLength(0)
    const out = service.list({ direction: 'out' })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'system' })
    expect(out[0]!.text).toContain('未生效')
  })

  it('rejects unknown ids and malformed envelopes the same way', async () => {
    const deps = depsWithRegistry(3)
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    runtime.postUserMessage(envelope('never-rendered', 1))
    runtime.postUserMessage('@[ui:sales-form:notanumber] {}')
    await vi.waitFor(() => expect(service.pendingInbound()).toHaveLength(0))
    expect(deps.liveFollowups).toHaveLength(0)
    expect(service.list({ direction: 'out' })).toHaveLength(2)
  })

  it('records identical send-back texts per send action (clientId idempotency)', async () => {
    const deps = depsWithRegistry(3)
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    // Two submits of the same stale payload are byte-identical texts (the
    // user refilled the same fields) — the content-fingerprint default
    // idempotency would swallow the second one before the gate ever saw it
    // (found by the P2 E2E). A per-send clientId keeps both rows, so the
    // gate rejects each with its own visible notice and no model turn.
    runtime.postUserMessage(envelope('sales-form', 2), 'client-1')
    runtime.postUserMessage(envelope('sales-form', 2), 'client-2')
    await vi.waitFor(() => expect(service.pendingInbound()).toHaveLength(0))
    expect(deps.liveFollowups).toHaveLength(0)
    expect(service.list({ direction: 'out' })).toHaveLength(2)
  })

  it('passes ordinary user text through untouched when no registry exists', async () => {
    const deps = fakeDeps({ live: true })
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    runtime.postUserMessage('@[ui:sales-form:1] {"component":"form","event":"submit","payload":{}}')
    runtime.postUserMessage('普通消息')
    await vi.waitFor(() => expect(deps.liveFollowups).toHaveLength(1))
    // No registry → every send-back-shaped row is rejected (fail closed), so
    // only the ordinary text reaches the model.
    expect(deps.liveFollowups[0]).toContain('普通消息')
    expect(deps.liveFollowups[0]).not.toContain('sales-form')
    await vi.waitFor(() => expect(service.pendingInbound()).toHaveLength(0))
  })

  it('falls back to the persisted ui_instructions revision after a restart (G3)', async () => {
    // No live registry (web-ui plugin absent / fresh process): the persisted
    // instruction keeps the gate open for the surface it recorded.
    const deps = fakeDeps({ live: true })
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()
    store.saveUiInstruction({
      id: 'sales-form',
      revision: 2,
      component: 'form',
      props: { fields: [{ id: 'city', label: '城市', type: 'text' }] },
      summary: '城市表单',
      sessionId: BUTLER_SESSION_ID,
      createdAt: new Date().toISOString(),
    })

    runtime.postUserMessage(envelope('sales-form', 2)) // current → delivers
    runtime.postUserMessage(envelope('sales-form', 1)) // stale → rejected
    await vi.waitFor(() => expect(deps.liveFollowups).toHaveLength(1))
    expect(deps.liveFollowups[0]).toContain('sales-form')
    await vi.waitFor(() => expect(service.pendingInbound()).toHaveLength(0))
    expect(service.list({ direction: 'out' })).toHaveLength(1)
  })
})

describe('renderInbound v2 (perception B12′ §5.1)', () => {
  const now = new Date('2026-11-10T09:05:00.000Z')
  const base = {
    direction: 'in' as const,
    idempotencyKey: 'k',
    read: false,
    delivered: true,
    createdAt: '2026-11-10T09:00:00.000Z',
  }

  function row(partial: Partial<Message> & { id: string; kind: Message['kind']; text: string }): Message {
    return { ...base, ...partial }
  }

  it('frames user text with its relative age', () => {
    const out = renderInbound([row({ id: '1', kind: 'text', text: '帮我看下项目' })], now)
    expect(out).toContain('【用户｜5分钟前】')
    expect(out).toContain('帮我看下项目')
  })

  it('renders receipt refs and title even without data (old rows)', () => {
    const out = renderInbound(
      [
        row({
          id: '2',
          kind: 'receipt',
          refs: { ticketId: 'tkt_abc', sessionId: 'resident-worker-tkt_abc' },
          title: '任务完成：整理下载目录',
          text: '已整理 3 个文件',
        }),
      ],
      now,
    )
    expect(out).toContain('【任务回执｜5分钟前｜ticket=tkt_abc｜session=resident-worker-tkt_abc】')
    expect(out).toContain('（标题）任务完成：整理下载目录')
    expect(out).toContain('已整理 3 个文件')
  })

  it('renders receipt data: run/duration/outcome and the artifact line', () => {
    const out = renderInbound(
      [
        row({
          id: '3',
          kind: 'receipt',
          refs: { ticketId: 't1', sessionId: 's1' },
          title: '任务完成：整理下载目录',
          text: '已整理 3 个文件',
          data: {
            outcome: 'completed',
            runId: 7,
            startedAt: '2026-11-10T08:00:00.000Z',
            finishedAt: '2026-11-10T08:00:48.000Z',
            durationMs: 48_000,
            artifacts: [
              { name: 'chart.png', path: 'D:\\ws\\chart.png', size: 12_288, kind: 'image' },
              { name: 'report.md', path: 'D:\\ws\\report.md', size: 3_072, kind: 'file' },
            ],
          },
        }),
      ],
      now,
    )
    expect(out).toContain('【任务回执｜5分钟前｜ticket=t1｜session=s1｜run=7｜48s｜completed】')
    expect(out).toContain('（产出）chart.png(12KB,image)；report.md(3KB,file)')
  })

  it('renders event code/source/untrusted flags and refs', () => {
    const out = renderInbound(
      [
        row({
          id: '4',
          kind: 'event',
          refs: { sourceId: 'm1', ticketId: 't1' },
          title: '来源降级',
          text: '连续 3 次检查失败',
          data: { code: 'monitor_degraded', sourceId: 'm1', untrusted: true },
        }),
      ],
      now,
    )
    expect(out).toContain('【事件｜5分钟前｜source=m1｜untrusted=true｜code=monitor_degraded｜ticket=t1】')
    expect(out).toContain('（标题）来源降级')
    expect(out).toContain('连续 3 次检查失败')
  })

  it('renders approval metadata and the requires-user flag', () => {
    const out = renderInbound(
      [
        row({
          id: '5',
          kind: 'approval',
          refs: { ticketId: 't1', sessionId: 's1' },
          text: 'worker 发起了审批请求',
          data: { approvalId: 'apr_8f3', toolName: 'write', requiresUser: true },
        }),
      ],
      now,
    )
    expect(out).toContain('【审批请求｜5分钟前｜apr=apr_8f3｜tool=write｜ticket=t1｜session=s1｜需用户确认】')
    expect(out).toContain('worker 发起了审批请求')
  })

  it('renders age as 刚刚 for future or malformed timestamps', () => {
    const out = renderInbound(
      [
        { ...base, id: '6', kind: 'text' as const, text: 'hi', createdAt: '2099-01-01T00:00:00.000Z' },
        { ...base, id: '7', kind: 'text' as const, text: 'hi', createdAt: '' },
      ],
      now,
    )
    expect(out).toContain('【用户｜刚刚】')
  })

  it('caps the body at 1200 characters and marks the cut', () => {
    const long = 'x'.repeat(1300)
    const out = renderInbound([row({ id: '8', kind: 'text', text: long })], now)
    const bodyLine = out.split('\n').find((line) => line.includes('x'))!
    expect(bodyLine.length).toBe(1201) // 1200 chars + the ellipsis
    expect(bodyLine.endsWith('…')).toBe(true)
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

describe('renderUi (genui-agui-optimization.md G4)', () => {
  it('persists the instruction and announces it as a kind=ui attachment reference', async () => {
    const registry = new RevisionRegistry()
    const deps = fakeDeps({ live: true, revisions: registry })
    const { runtime, service } = makeRuntime(deps)
    await runtime.start()

    const outcome = runtime.renderUi({
      id: 'sales-chart',
      component: 'chart',
      summary: '近六月营收趋势',
      props: { chartType: 'line' },
      data: { items: [] },
      provenance: '来源：本轮读取的 sales.csv',
    })
    expect(outcome).toMatchObject({ recorded: true, revision: 1 })

    // Persisted (the send-back gate's post-restart fallback).
    expect(store.getUiInstruction('sales-chart')).toMatchObject({
      revision: 1,
      component: 'chart',
      summary: '近六月营收趋势',
      sessionId: BUTLER_SESSION_ID,
    })
    // Registry recorded for the live gate.
    expect(registry.latest(BUTLER_SESSION_ID, 'sales-chart')).toBe(1)

    // Announced: one outbound text bubble with one kind='ui' reference — the
    // JSON itself never rides in the message.
    const out = service.list({ direction: 'out' })
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('text')
    expect(out[0]!.text).toBe('近六月营收趋势')
    const [attachment] = out[0]!.attachments ?? []
    expect(attachment).toMatchObject({ kind: 'ui', name: '近六月营收趋势' })
    expect(attachment!.url).toBe('/resident/api/ui-instruction?id=sales-chart&revision=1')

    // Re-emit with revision 2: new persisted revision + new announcement.
    runtime.renderUi({ id: 'sales-chart', revision: 2, component: 'chart', summary: '近六月营收趋势（更新）' })
    expect(store.latestUiInstructionRevision('sales-chart')).toBe(2)
    expect(registry.latest(BUTLER_SESSION_ID, 'sales-chart')).toBe(2)
    expect(service.list({ direction: 'out' })).toHaveLength(2)

    // Same (id, revision) re-emit is deduplicated by the idempotency key.
    const again = runtime.renderUi({ id: 'sales-chart', revision: 2, component: 'chart', summary: '近六月营收趋势（更新）' })
    expect(again.recorded).toBe(false)
    expect(service.list({ direction: 'out' })).toHaveLength(2)
  })
})

describe('settings', () => {
  it('returns the panel defaults and round-trips an explicit patch', () => {
    const deps = fakeDeps()
    const { runtime } = makeRuntime(deps)

    expect(runtime.settings()).toMatchObject({
      workerSlots: 2,
      observeMode: true,
      approvalDelegation: true,
      perceptionEvents: true,
      stallMinutes: 10,
      reminderMinutes: 30,
    })

    const saved = runtime.saveSettings({
      quietHours: { start: '22:30', end: '07:00' },
      workerSlots: 4,
      observeMode: false,
      approvalDelegation: false,
      perceptionEvents: false,
      stallMinutes: 20,
      reminderMinutes: 60,
    })
    expect(saved.quietHours).toEqual({ start: '22:30', end: '07:00' })
    expect(saved.workerSlots).toBe(4)
    expect(saved.observeMode).toBe(false)
    expect(saved.approvalDelegation).toBe(false)
    expect(saved.perceptionEvents).toBe(false)
    expect(saved.stallMinutes).toBe(20)
    expect(saved.reminderMinutes).toBe(60)
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

describe('read API (B12′ §5.5)', () => {
  it('marks outbound rows read by ids or up to a cursor', () => {
    const deps = fakeDeps({ live: true })
    const { runtime, service } = makeRuntime(deps)
    service.postOutbound({ kind: 'report', title: 'a', text: '1' })
    service.postOutbound({ kind: 'system', title: 'b', text: '2' })
    service.postInbound({ kind: 'text', text: 'user' })
    const out = store.listMessages({ direction: 'out', oldestFirst: true })

    expect(runtime.unreadCount()).toBe(2)
    expect(runtime.markRead({ ids: [out[0]!.id] })).toBe(1)
    expect(runtime.unreadCount()).toBe(1)
    expect(runtime.markRead({ upTo: out[1]!.id })).toBe(1)
    expect(runtime.unreadCount()).toBe(0)
    expect(runtime.markRead({ ids: [] })).toBe(0)
    expect(runtime.markRead({ upTo: 'missing' })).toBe(0)
  })

  it('surfaces the do-not-disturb state in status()', () => {
    const service = new MessageService(store, { now: () => new Date('2026-11-11T23:30:00') })
    const { runtime } = makeRuntime(fakeDeps(), service)
    expect(runtime.status().quiet).toBe(false)
    runtime.saveSettings({ quietHours: { start: '22:00', end: '07:00' } })
    expect(runtime.status().quiet).toBe(true)
  })
})
