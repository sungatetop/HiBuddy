import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { Ticket } from './domain.ts'
import { transitionTicket } from './state-machine.ts'
import { Store } from './store.ts'
import { WorkerOrchestrator, buildPrompt, summarizeRound, type WorkerDeps } from './worker.ts'

let dir: string
let store: Store

function ticket(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
    goal: '整理下载目录',
    mandate: 'explicit',
    origin: 'user',
    state: 'pending',
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
    ...partial,
  }
}

/** Seed a ticket as `working` — the state the dispatcher receives from the scheduler. */
function seedWorking(partial: Partial<Ticket> & { id: string }): Ticket {
  const t = ticket({ state: 'working', ...partial })
  store.upsertTicket(t)
  return store.getTicket(t.id)!
}

/** Minimal fake agent: events appear in the window only after followup() — like a real round. */
function fakeAgent(events: Array<Record<string, unknown>>): Agent {
  let started = false
  return {
    session: {
      get seq() {
        return started ? events.length : 0
      },
      snapshotEvents: (from: number, to: number) => (started ? events.slice(from, to) : []),
    },
    status: 'idle',
    whenIdle: async () => {},
    followup: () => {
      started = true
    },
    cancel: () => {},
  } as unknown as Agent
}

const COMPLETED: Array<Record<string, unknown>> = [
  { type: 'turn/start', seq: 0, time: 0, data: {} },
  {
    type: 'assistant/message',
    seq: 1,
    time: 0,
    data: { message: { content: [{ type: 'text', text: '已完成：整理了 3 个文件' }] } },
  },
  { type: 'turn/end', seq: 2, time: 0, data: { reason: { kind: 'completed' } } },
]

/**
 * Fake worker deps: in-memory agent registry over canned agents. `events`
 * applies to the NEXT opened session; `createError`/`resumeError` simulate
 * open failures.
 */
function fakeDeps(options: {
  events?: Array<Record<string, unknown>>
  live?: Agent
  createError?: Error
  resumeError?: Error
} = {}): WorkerDeps & { created: CreateAgentOptions[]; resumed: ResumeAgentOptions[] } {
  const created: CreateAgentOptions[] = []
  const resumed: ResumeAgentOptions[] = []
  const open = async (opts: CreateAgentOptions | ResumeAgentOptions, error?: Error): Promise<AgentHandle> => {
    if (error) throw error
    return { agent: fakeAgent(options.events ?? COMPLETED), dispose: async () => {} }
  }
  const ctx = {
    on: () => () => {},
    get: () => undefined,
  } as unknown as Context
  const agents = {
    get: () => options.live,
    create: async (opts: CreateAgentOptions) => {
      created.push(opts)
      return open(opts, options.createError)
    },
    resume: async (opts: ResumeAgentOptions) => {
      resumed.push(opts)
      return open(opts, options.resumeError)
    },
  } as unknown as AgentRegistry
  return {
    ctx,
    agents,
    presets: {
      resolve: async () => ({ id: 'preset-1' }),
      mount: async () => ({}),
    } as unknown as AgentPresetRegistry,
    defaultModel: {
      currentSelection: () => ({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' }),
    } as unknown as AgentDefaultModelConfig,
    created,
    resumed,
  }
}

/** Wait until the detached round settles (dispatch/resumeWorker run void async). */
async function settle(): Promise<void> {
  await vi.waitFor(() => new Promise((resolve) => setImmediate(resolve)))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-worker-'))
  store = Store.open(dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('slots', () => {
  it('defaults to 2 and follows the panel setting', () => {
    const orchestrator = new WorkerOrchestrator(fakeDeps(), store)
    expect(orchestrator.slots()).toBe(2)
    expect(orchestrator.canDispatch()).toBe(true)
    store.setSetting('workerSlots', 1)
    expect(orchestrator.slots()).toBe(1)
    store.setSetting('workerSlots', 0)
    expect(orchestrator.slots()).toBe(2)
  })
})

describe('dispatch: success paths', () => {
  it('completes a one-shot: ticket completed, run ok, worker session idle', async () => {
    const deps = fakeDeps()
    const orchestrator = new WorkerOrchestrator(deps, store)
    seedWorking({ id: 't1' })

    orchestrator.dispatch(store.getTicket('t1')!, { late: false })
    await settle()

    const reloaded = store.getTicket('t1')!
    expect(reloaded.state).toBe('completed')
    expect(reloaded.summary).toBe('已完成：整理了 3 个文件')
    expect(reloaded.sessionId).toBe('resident-worker-t1')
    expect(reloaded.nextRunAt).toBeNull()

    const worker = store.getWorkerSession('t1')!
    expect(worker.state).toBe('idle')
    expect(worker.sessionId).toBe('resident-worker-t1')
    expect(worker.lastReport).toBe('已完成：整理了 3 个文件')

    const runs = store.listRuns('t1')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.outcome).toBe('ok')

    // composeAgent three elements on create
    expect(deps.created).toHaveLength(1)
    expect(deps.created[0]!.sessionId).toBe('resident-worker-t1')
    expect(deps.created[0]!.meta).toMatchObject({ agentPreset: 'preset-1' })
    expect(deps.created[0]!.agentOptions).toMatchObject({ provider: 'minimax-cn' })
    expect(deps.created[0]!.meta!.cwd).toContain(join('resident-work', 't1'))
    expect(deps.resumed).toHaveLength(0)
  })

  it('completes a periodic round: back to pending with the precomputed occurrence', async () => {
    const orchestrator = new WorkerOrchestrator(fakeDeps(), store)
    const next = new Date(Date.now() + 3_600_000).toISOString()
    seedWorking({ id: 'loop', period: { intervalMs: 3_600_000 }, nextRunAt: next })

    orchestrator.dispatch(store.getTicket('loop')!, { late: false })
    await settle()

    const reloaded = store.getTicket('loop')!
    expect(reloaded.state).toBe('pending')
    expect(reloaded.nextRunAt).toBe(next)
    expect(reloaded.summary).toBe('已完成：整理了 3 个文件')
  })

  it('resumes the persisted session when the ticket ran before', async () => {
    const deps = fakeDeps()
    const orchestrator = new WorkerOrchestrator(deps, store)
    const t = seedWorking({ id: 't2' })
    store.upsertWorkerSession({ ticketId: 't2', sessionId: 'resident-worker-t2', state: 'idle' })

    orchestrator.dispatch(t, { late: false })
    await settle()

    expect(deps.resumed).toHaveLength(1)
    expect(deps.resumed[0]!.resumeSessionId).toBe('resident-worker-t2')
    expect(deps.created).toHaveLength(0)
    expect(store.getTicket('t2')!.state).toBe('completed')
  })

  it('reuses the live agent without re-opening the session', async () => {
    const live = fakeAgent(COMPLETED)
    const deps = fakeDeps({ live })
    const orchestrator = new WorkerOrchestrator(deps, store)
    const t = seedWorking({ id: 't3' })
    store.upsertWorkerSession({ ticketId: 't3', sessionId: 'resident-worker-t3', state: 'idle' })

    orchestrator.dispatch(t, { late: false })
    await settle()

    expect(deps.created).toHaveLength(0)
    expect(deps.resumed).toHaveLength(0)
    expect(store.getTicket('t3')!.state).toBe('completed')
  })

  it('frees the slot after the round settles', async () => {
    const orchestrator = new WorkerOrchestrator(fakeDeps(), store)
    const t = seedWorking({ id: 't4' })
    orchestrator.dispatch(t, { late: false })
    await settle()
    expect(orchestrator.canDispatch()).toBe(true)
  })
})

describe('dispatch: failure paths', () => {
  it('fails the ticket when the session cannot be opened (no auto retry)', async () => {
    const deps = fakeDeps({ createError: new Error('no factory') })
    const orchestrator = new WorkerOrchestrator(deps, store)
    seedWorking({ id: 'bad' })

    orchestrator.dispatch(store.getTicket('bad')!, { late: false })
    await settle()

    const reloaded = store.getTicket('bad')!
    expect(reloaded.state).toBe('failed')
    expect(reloaded.summary).toContain('worker 会话打开失败')
    const runs = store.listRuns('bad')
    expect(runs[0]!.outcome).toBe('failed')
    expect(runs[0]!.detail).toContain('no factory')
    expect(store.getWorkerSession('bad')!.state).toBe('blocked')
  })

  it('fails the ticket when the turn ends with an error reason', async () => {
    const orchestrator = new WorkerOrchestrator(
      fakeDeps({
        events: [
          { type: 'turn/start', seq: 0, time: 0, data: {} },
          { type: 'turn/end', seq: 1, time: 0, data: { reason: { kind: 'error', error: { message: 'boom', code: 'X' } } } },
        ],
      }),
      store,
    )
    seedWorking({ id: 'err' })

    orchestrator.dispatch(store.getTicket('err')!, { late: false })
    await settle()

    const reloaded = store.getTicket('err')!
    expect(reloaded.state).toBe('failed')
    const runs = store.listRuns('err')
    expect(runs[0]!.outcome).toBe('failed')
    expect(runs[0]!.detail).toContain('error')
  })

  it('keeps a blocked turn working and flags the worker session (B7 takes over)', async () => {
    const orchestrator = new WorkerOrchestrator(
      fakeDeps({
        events: [
          { type: 'turn/start', seq: 0, time: 0, data: {} },
          { type: 'turn/end', seq: 1, time: 0, data: { reason: { kind: 'blocked' } } },
        ],
      }),
      store,
    )
    seedWorking({ id: 'blk' })

    orchestrator.dispatch(store.getTicket('blk')!, { late: false })
    await settle()

    expect(store.getTicket('blk')!.state).toBe('working')
    expect(store.getWorkerSession('blk')!.state).toBe('awaiting_approval')
    expect(store.listRuns('blk')[0]!.outcome).toBe('awaiting_approval')
  })

  it('ignores a double dispatch for the same ticket', async () => {
    const deps = fakeDeps({ createError: new Error('no factory') })
    const orchestrator = new WorkerOrchestrator(deps, store)
    seedWorking({ id: 'dup' })
    orchestrator.dispatch(store.getTicket('dup')!, { late: false })
    await settle()

    // failed already; a second dispatch for the same id must not re-open
    orchestrator.dispatch(store.getTicket('dup')!, { late: false })
    await settle()
    expect(deps.created).toHaveLength(1)
  })
})

describe('recovery (reconcile hook)', () => {
  it('reopens the session with the recovery note and completes the round', async () => {
    const deps = fakeDeps()
    const orchestrator = new WorkerOrchestrator(deps, store)
    seedWorking({ id: 'rec' })

    const resumed = await orchestrator.resumeWorker(store.getTicket('rec')!)
    await settle()

    expect(resumed).toBe(true)
    expect(deps.created).toHaveLength(1)
    expect(deps.created[0]!.meta!.cwd).toContain(join('resident-work', 'rec'))
    expect(store.getTicket('rec')!.state).toBe('completed')
    const runs = store.listRuns('rec')
    expect(runs[0]!.detail).toContain('recovery')
  })

  it('recomputes a stale occurrence for a recovered periodic ticket', async () => {
    const orchestrator = new WorkerOrchestrator(fakeDeps(), store)
    seedWorking({ id: 'loop', period: { intervalMs: 3_600_000 }, nextRunAt: '2026-11-05T09:00:00.000Z' })

    await orchestrator.resumeWorker(store.getTicket('loop')!)
    await settle()

    const reloaded = store.getTicket('loop')!
    expect(reloaded.state).toBe('pending')
    expect(Date.parse(reloaded.nextRunAt!)).toBeGreaterThan(Date.now())
  })

  it('refuses when the single slot is busy so reconciliation marks interrupted instead', async () => {
    // A never-settling round occupies the only slot.
    const hanging = fakeAgent(COMPLETED)
    ;(hanging as unknown as { whenIdle: () => Promise<void> }).whenIdle = () => new Promise(() => {})
    const orchestrator = new WorkerOrchestrator(fakeDeps({ live: hanging }), store)
    store.setSetting('workerSlots', 1)
    seedWorking({ id: 'busy' })
    orchestrator.dispatch(store.getTicket('busy')!, { late: false })
    await settle()

    seedWorking({ id: 'noslot' })
    expect(await orchestrator.resumeWorker(store.getTicket('noslot')!)).toBe(false)
    expect(store.getTicket('noslot')!.state).toBe('working')
    expect(store.listRuns('noslot')).toHaveLength(0)
  })
})

describe('prompt composition', () => {
  it('carries the goal and the late/recovery/round notes', () => {
    const t = ticket({ id: 'p' })
    expect(buildPrompt(t, 0, { late: false, recovery: false })).toContain('整理下载目录')
    expect(buildPrompt(t, 0, { late: true, recovery: false })).toContain('补偿执行')
    expect(buildPrompt(t, 0, { late: false, recovery: true })).toContain('重启')
    expect(buildPrompt(t, 2, { late: false, recovery: false })).toContain('新一轮')
    expect(buildPrompt(t, 0, { late: false, recovery: false })).not.toContain('新一轮')
  })

  it('records the late flag in the run detail', async () => {
    const orchestrator = new WorkerOrchestrator(fakeDeps(), store)
    seedWorking({ id: 'late' })
    orchestrator.dispatch(store.getTicket('late')!, { late: true })
    await settle()
    expect(store.listRuns('late')[0]!.detail).toContain('late compensation')
  })
})

describe('summarizeRound', () => {
  it('extracts the last assistant text and terminal reason from the owned interval', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 0, data: {} },
      { type: 'assistant/message', seq: 1, time: 0, data: { message: { content: [{ type: 'text', text: '第一段' }] } } },
      { type: 'turn/end', seq: 2, time: 0, data: { reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 3, time: 0, data: {} },
      { type: 'assistant/message', seq: 4, time: 0, data: { message: { content: [{ type: 'text', text: '最终回复' }] } } },
      { type: 'turn/end', seq: 5, time: 0, data: { reason: { kind: 'max-tokens' } } },
    ]
    const session = {
      seq: events.length,
      snapshotEvents: (from: number, to: number) => events.slice(from, to),
    } as never
    const summary = summarizeRound(session as never, 0 as never)
    expect(summary.text).toBe('最终回复')
    expect(summary.reason?.kind).toBe('max-tokens')
  })
})
