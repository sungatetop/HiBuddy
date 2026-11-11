import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Ticket } from './domain.ts'
import { EdgeDetector, type EdgeOptions } from './edge.ts'
import { MessageService } from './messages.ts'
import { Store } from './store.ts'

let dir: string
let store: Store
let now: Date

/** Fake ctx capturing the session/event handler so tests can emit events. */
function fakeCtx(): { ctx: Context; emit: (sessionId: string) => void } {
  let handler: ((session: { id: string }) => void) | undefined
  const ctx = {
    on: vi.fn((_event: string, h: (session: { id: string }) => void) => {
      handler = h
      return () => {
        handler = undefined
      }
    }),
  } as unknown as Context
  return {
    ctx,
    emit: (sessionId: string) => handler?.({ id: sessionId }),
  }
}

function ticket(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
    goal: `任务 ${partial.id}`,
    mandate: 'explicit',
    origin: 'user',
    state: 'working',
    createdAt: '2026-11-11T07:00:00.000Z',
    updatedAt: '2026-11-11T07:00:00.000Z',
    ...partial,
  }
}

/** A detector over the shared store/clock, ready for scans. */
function makeDetector(ctx: Context, options: Partial<EdgeOptions> = {}): EdgeDetector {
  const notifier = new MessageService(store, { now: () => now })
  return new EdgeDetector(ctx, store, notifier, {
    now: () => now,
    stallMinutes: () => 10,
    reminderMinutes: () => 30,
    ...options,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-edge-'))
  store = Store.open(dir)
  now = new Date('2026-11-11T08:00:00.000Z')
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('stalled / resumed', () => {
  it('flags a stalled working ticket once per run and resumes on the first event', () => {
    const { ctx, emit } = fakeCtx()
    const detector = makeDetector(ctx)
    store.upsertTicket(ticket({ id: 't1', sessionId: 'resident-worker-t1' }))
    const runId = store.startRun('t1', '2026-11-11T07:00:00.000Z')
    expect(runId).toBe(1)

    // The session produced its last event at 07:30.
    now = new Date('2026-11-11T07:30:00.000Z')
    emit('resident-worker-t1')

    now = new Date('2026-11-11T08:00:00.000Z') // 30m of silence > 10m threshold
    detector.scan()

    const stalled = store.listMessages().filter((m) => m.kind === 'event')
    expect(stalled).toHaveLength(1)
    expect(stalled[0]!.data).toMatchObject({ code: 'stalled' })
    expect(stalled[0]!.refs).toMatchObject({ ticketId: 't1', sessionId: 'resident-worker-t1' })
    expect(stalled[0]!.idempotencyKey).toBe('stall:t1:1')

    // Same run, still stalled → no duplicate.
    detector.scan()
    expect(store.listMessages().filter((m) => m.kind === 'event')).toHaveLength(1)

    // First event afterwards → resumed.
    now = new Date('2026-11-11T08:05:00.000Z')
    emit('resident-worker-t1')
    detector.scan()
    const events = store.listMessages().filter((m) => m.kind === 'event')
    expect(events).toHaveLength(2)
    // Newest-first listing: the resumed event is the first row.
    expect(events[0]!.data).toMatchObject({ code: 'resumed' })
    expect(events[0]!.idempotencyKey).toBe('resume:t1:1')
  })

  it('does not flag a session that still emits events', () => {
    const { ctx, emit } = fakeCtx()
    const detector = makeDetector(ctx)
    store.upsertTicket(ticket({ id: 't2', sessionId: 'resident-worker-t2' }))
    store.startRun('t2', '2026-11-11T07:00:00.000Z')

    emit('resident-worker-t2') // activity at 08:00
    detector.scan()
    expect(store.listMessages().filter((m) => m.kind === 'event')).toHaveLength(0)
  })

  it('suppresses stall events inside the do-not-disturb window', () => {
    const { ctx } = fakeCtx()
    store.setSetting('quietHours', { start: '22:00', end: '07:00' })
    // 15:00Z = 23:00 local (+08:00) — inside the window (local-time arithmetic).
    now = new Date('2026-11-11T15:00:00.000Z')
    const detector = makeDetector(ctx)
    store.upsertTicket(ticket({ id: 't3', sessionId: 'resident-worker-t3', updatedAt: '2026-11-11T14:00:00.000Z' }))
    store.startRun('t3', '2026-11-11T14:00:00.000Z')

    detector.scan()
    expect(store.listMessages()).toHaveLength(0)
  })

  it('honours the perceptionEvents master switch', () => {
    const { ctx } = fakeCtx()
    const detector = makeDetector(ctx, { enabled: () => false })
    store.upsertTicket(ticket({ id: 't4', sessionId: 'resident-worker-t4', updatedAt: '2026-11-11T07:00:00.000Z' }))
    store.startRun('t4', '2026-11-11T07:00:00.000Z')

    detector.scan()
    expect(store.listMessages()).toHaveLength(0)
  })
})

describe('question_unanswered', () => {
  it('reminds about an unread question past reminderMinutes, once per message', () => {
    const { ctx } = fakeCtx()
    const notifier = new MessageService(store, { now: () => now })
    const detector = new EdgeDetector(ctx, store, notifier, {
      now: () => now,
      stallMinutes: () => 10,
      reminderMinutes: () => 30,
    })
    notifier.postOutbound({ kind: 'question', text: '这个方案你接受吗？' }) // at 08:00, unread

    now = new Date('2026-11-11T08:31:00.000Z') // +31m > 30m
    detector.scan()

    const events = store.listMessages().filter((m) => m.kind === 'event')
    expect(events).toHaveLength(1)
    expect(events[0]!.data).toMatchObject({ code: 'question_unanswered' })
    expect(events[0]!.idempotencyKey).toMatch(/^question:msg_/)
    expect(events[0]!.text).toContain('这个方案你接受吗')

    detector.scan() // same reminder window → deduped
    expect(store.listMessages().filter((m) => m.kind === 'event')).toHaveLength(1)
  })

  it('skips a question the user answered afterwards', () => {
    const { ctx } = fakeCtx()
    const notifier = new MessageService(store, { now: () => now })
    const detector = new EdgeDetector(ctx, store, notifier, {
      now: () => now,
      stallMinutes: () => 10,
      reminderMinutes: () => 30,
    })
    notifier.postOutbound({ kind: 'question', text: '继续吗？' }) // 08:00
    now = new Date('2026-11-11T08:05:00.000Z')
    notifier.postInbound({ kind: 'text', text: '继续' }) // user answered

    now = new Date('2026-11-11T08:31:00.000Z')
    detector.scan()
    expect(store.listMessages().filter((m) => m.kind === 'event')).toHaveLength(0)
  })

  it('suppresses the reminder inside the window', () => {
    const { ctx } = fakeCtx()
    const notifier = new MessageService(store, { now: () => now })
    const detector = new EdgeDetector(ctx, store, notifier, {
      now: () => now,
      stallMinutes: () => 10,
      reminderMinutes: () => 30,
    })
    notifier.postOutbound({ kind: 'question', text: '还在吗？' }) // 08:00Z = 16:00 local

    store.setSetting('quietHours', { start: '22:00', end: '07:00' })
    now = new Date('2026-11-11T15:00:00.000Z') // 23:00 local, inside the window
    detector.scan()
    expect(store.listMessages().filter((m) => m.kind === 'event')).toHaveLength(0)
  })
})

describe('start / stop', () => {
  it('starts a periodic scan and stops cleanly', () => {
    vi.useFakeTimers()
    try {
      const { ctx } = fakeCtx()
      const detector = makeDetector(ctx, { scanIntervalMs: 30_000 })
      store.upsertTicket(ticket({ id: 't9', sessionId: 'resident-worker-t9', updatedAt: '2026-11-11T07:00:00.000Z' }))
      store.startRun('t9', '2026-11-11T07:00:00.000Z')

      detector.start()
      vi.advanceTimersByTime(30_000)
      expect(store.listMessages().filter((m) => m.kind === 'event')).toHaveLength(1)

      detector.stop()
      const before = store.listMessages().length
      vi.advanceTimersByTime(90_000)
      expect(store.listMessages().length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
