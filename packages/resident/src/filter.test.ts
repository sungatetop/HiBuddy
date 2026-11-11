import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ticket, Trigger } from './domain.ts'
import { fingerprintOf } from './monitor.ts'
import { FilterPipeline, type Assessment, type Assessor, type AssessmentInput } from './filter.ts'
import { MessageService } from './messages.ts'
import { Store } from './store.ts'

let dir: string
let store: Store
let currentMs: number

/** Scriptable assessor returning canned verdicts; records inputs. */
function fakeAssessor(verdicts: Assessment[]): Assessor & { inputs: AssessmentInput[] } {
  const inputs: AssessmentInput[] = []
  let i = 0
  return {
    inputs,
    assess(_sourceId, input) {
      inputs.push(input)
      const next = verdicts[i++]
      if (!next) throw new Error('assessment script exhausted')
      return Promise.resolve(next)
    },
  }
}

function makePipeline(assessor: Assessor, observeMode = true): FilterPipeline {
  // Fixed-clock notifier so do-not-disturb checks (B12′ D4 monitor_triggered)
  // are deterministic: noon, outside any window.
  const notifier = new MessageService(store, { now: () => new Date(currentMs) })
  return new FilterPipeline(store, {
    assessor,
    observeMode: () => observeMode,
    now: () => new Date(currentMs),
    notifier,
  })
}

function seedMonitor(id = 'm1', config: unknown = undefined): void {
  store.upsertSource({
    id,
    kind: 'monitor',
    enabled: true,
    config: config ?? { target: 'file:///w.txt', condition: '包含 HIT', intervalMs: 60_000 },
  })
}

function hitTrigger(sourceId = 'm1', snapshot = 'A', overrides: Record<string, unknown> = {}): Trigger {
  return {
    id: `trg_${sourceId}-${snapshot}`,
    sourceId,
    at: new Date(currentMs).toISOString(),
    payload: {
      target: 'file:///w.txt',
      condition: '包含 HIT',
      fingerprint: fingerprintOf(snapshot),
      rationale: '文件中出现 HIT',
      ...overrides,
    },
  }
}

function ticket(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
    goal: 'g',
    mandate: 'explicit',
    origin: 'user',
    state: 'pending',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    ...partial,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-filter-'))
  store = Store.open(dir)
  currentMs = Date.parse('2026-11-06T12:00:00.000Z')
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('filter: gate (deterministic)', () => {
  it('drops triggers for unknown or disabled sources', async () => {
    seedMonitor()
    const assessor = fakeAssessor([{ act: true, reason: 'r' }])
    const pipeline = makePipeline(assessor)

    expect(await pipeline.handle(hitTrigger('ghost'))).toBe('dropped')
    store.upsertSource({ ...store.getSource('m1')!, enabled: false })
    expect(await pipeline.handle(hitTrigger())).toBe('dropped')
    expect(assessor.inputs).toHaveLength(0)
  })

  it('drops malformed payloads', async () => {
    seedMonitor()
    const pipeline = makePipeline(fakeAssessor([]))
    expect(await pipeline.handle(hitTrigger('m1', 'A', { rationale: undefined }))).toBe('dropped')
    expect(await pipeline.handle({ ...hitTrigger(), payload: null })).toBe('dropped')
  })

  it('skips while an open ticket from the same monitor exists', async () => {
    seedMonitor()
    store.upsertTicket(ticket({ id: 't1', origin: 'monitor:m1', state: 'working' }))
    const pipeline = makePipeline(fakeAssessor([]))

    expect(await pipeline.handle(hitTrigger())).toBe('skipped')
    expect(store.listTickets('pending')).toHaveLength(0)
  })
})

describe('filter: assessment and observe mode', () => {
  it('passes condition, evidence and related ticket context to the assessor', async () => {
    seedMonitor()
    store.upsertTicket(ticket({ id: 't-done', origin: 'monitor:m1', state: 'completed', summary: '上次处理过' }))
    store.upsertTicket(ticket({ id: 't-other', origin: 'monitor:m2', state: 'pending' }))
    const assessor = fakeAssessor([{ act: false, reason: 'no' }])
    const pipeline = makePipeline(assessor)

    await pipeline.handle(hitTrigger())

    expect(assessor.inputs).toHaveLength(1)
    expect(assessor.inputs[0]).toMatchObject({ condition: '包含 HIT', rationale: '文件中出现 HIT' })
    expect(assessor.inputs[0]!.relatedTickets).toEqual([
      { id: 't-done', state: 'completed', summary: '上次处理过' },
    ])
  })

  it('observes by default: records would-act once, creates no ticket', async () => {
    seedMonitor()
    const pipeline = makePipeline(fakeAssessor([{ act: true, reason: '值得处理' }, { act: true, reason: '值得处理' }]))

    expect(await pipeline.handle(hitTrigger())).toBe('observed')

    const reports = store.listMessages().filter((m) => m.kind === 'event')
    expect(reports).toHaveLength(1)
    expect(reports[0]!.idempotencyKey).toBe(`monitor:m1:would-act:${fingerprintOf('A')}`)
    expect(reports[0]!.text).toContain('值得处理')
    expect(store.listTickets()).toHaveLength(0)

    // same fingerprint re-hit → deduped by the idempotency key
    expect(await pipeline.handle(hitTrigger())).toBe('observed')
    expect(store.listMessages().filter((m) => m.kind === 'event')).toHaveLength(1)
  })

  it('acts in auto mode: inferred ticket, due immediately', async () => {
    seedMonitor('m1')
    const pipeline = makePipeline(fakeAssessor([{ act: true, reason: '需要处理' }]), false)

    expect(await pipeline.handle(hitTrigger())).toBe('acted')

    const tickets = store.listTickets()
    expect(tickets).toHaveLength(1)
    expect(tickets[0]).toMatchObject({
      mandate: 'inferred',
      origin: 'monitor:m1',
      state: 'pending',
      nextRunAt: new Date(currentMs).toISOString(),
    })
    expect(tickets[0]!.goal).toContain('包含 HIT')
    expect(tickets[0]!.goal).toContain('需要处理')

    // L1 causality: the butler learns which monitor + fingerprint created it.
    const events = store.listMessages().filter((m) => m.kind === 'event')
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toMatchObject({ code: 'monitor_triggered', sourceId: 'm1', ticketId: tickets[0]!.id })
    expect(events[0]!.idempotencyKey).toBe(`monitor:m1:triggered:${fingerprintOf('A')}`)
  })

  it('dedupes monitor_triggered per fingerprint and suppresses it in the window', async () => {
    seedMonitor('m1')
    const pipeline = makePipeline(fakeAssessor([{ act: true, reason: 'r' }, { act: true, reason: 'r' }]), false)

    expect(await pipeline.handle(hitTrigger())).toBe('acted')
    // The open monitor ticket dedupes the re-hit at the gate — no second event.
    expect(await pipeline.handle(hitTrigger())).toBe('skipped')
    const events = store.listMessages().filter((m) => m.kind === 'event' && (m.data as { code?: string })?.code === 'monitor_triggered')
    expect(events).toHaveLength(1)

    // Do-not-disturb: a hit inside the window still creates the ticket but no
    // causality event (the situation snapshot shows the ticket by its origin).
    store.setSetting('quietHours', { start: '22:00', end: '07:00' })
    currentMs = Date.parse('2026-11-06T15:00:00.000Z') // 23:00 local (+08:00), inside the window
    seedMonitor('m2')
    const pipeline2 = makePipeline(fakeAssessor([{ act: true, reason: 'r2' }]), false)
    expect(await pipeline2.handle(hitTrigger('m2', 'B'))).toBe('acted')
    expect(store.listTickets()).toHaveLength(2)
    const suppressed = store.listMessages().filter(
      (m) => m.kind === 'event' && (m.data as { code?: string })?.code === 'monitor_triggered',
    )
    expect(suppressed).toHaveLength(1)
  })

  it('uses the configured goal override in auto mode', async () => {
    seedMonitor('m1', { target: 't', condition: 'c', intervalMs: 60_000, goal: '自定义目标' })
    const pipeline = makePipeline(fakeAssessor([{ act: true, reason: 'r' }]), false)

    expect(await pipeline.handle(hitTrigger())).toBe('acted')
    expect(store.listTickets()[0]!.goal).toBe('自定义目标')
  })

  it('takes no action when the assessor declines', async () => {
    seedMonitor()
    const pipeline = makePipeline(fakeAssessor([{ act: false, reason: '证据不足' }]), false)

    expect(await pipeline.handle(hitTrigger())).toBe('skipped')
    expect(store.listTickets()).toHaveLength(0)
    expect(store.listMessages()).toHaveLength(0)
  })
})
