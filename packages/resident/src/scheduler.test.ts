import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ticket } from './domain.ts'
import { transitionTicket } from './state-machine.ts'
import { Store } from './store.ts'
import { Scheduler, nextOccurrence, type TicketDispatcher } from './scheduler.ts'

const HOUR = 3_600_000

let dir: string
let store: Store
/** Fake clock, advanced by tests. */
let currentMs: number
/** Every scheduler created in a test; stopped in afterEach to avoid timer leaks. */
let schedulers: Scheduler[] = []

function ticket(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
    goal: 'g',
    mandate: 'explicit',
    origin: 'user',
    state: 'pending',
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    ...partial,
  }
}

/** Slot-counting dispatcher stub recording fired rounds. */
function fakeDispatcher(slots = { free: 1 }): TicketDispatcher & { fired: Array<{ ticket: Ticket; late: boolean }> } {
  const fired: Array<{ ticket: Ticket; late: boolean }> = []
  return {
    fired,
    canDispatch: () => slots.free > 0,
    dispatch: (t, info) => {
      slots.free -= 1
      fired.push({ ticket: t, late: info.late })
    },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-scheduler-'))
  store = Store.open(dir)
  currentMs = Date.parse('2026-11-05T12:00:00.000Z')
  schedulers = []
})

afterEach(() => {
  for (const scheduler of schedulers) scheduler.stop()
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeScheduler(dispatcher?: TicketDispatcher): Scheduler {
  const scheduler = new Scheduler(store, { dispatcher, now: () => new Date(currentMs) })
  schedulers.push(scheduler)
  return scheduler
}

describe('nextOccurrence', () => {
  it('returns the first anchor + k·interval strictly after now', () => {
    const from = Date.parse('2026-11-05T10:00:00.000Z')
    expect(nextOccurrence(from, HOUR, from + 1)).toBe('2026-11-05T11:00:00.000Z')
    expect(nextOccurrence(from, HOUR, from + HOUR)).toBe('2026-11-05T12:00:00.000Z')
    expect(nextOccurrence(from, HOUR, from + 3.5 * HOUR)).toBe('2026-11-05T14:00:00.000Z')
    // exactly on the boundary still yields the strictly-next round
    expect(nextOccurrence(from, HOUR, from)).toBe('2026-11-05T11:00:00.000Z')
  })
})

describe('scheduler: one-shot tickets', () => {
  it('fires a due one-shot once, flags it late, and leaves the scheduler index', () => {
    store.upsertTicket(ticket({ id: 'late', nextRunAt: '2026-11-05T09:00:00.000Z' }))
    const dispatcher = fakeDispatcher()

    const stats = makeScheduler(dispatcher).start()

    expect(stats.firedOneShots).toBe(1)
    expect(stats.lateOneShots).toBe(1)
    const reloaded = store.getTicket('late')!
    expect(reloaded.state).toBe('working')
    expect(reloaded.nextRunAt).toBeNull()
    expect(dispatcher.fired).toEqual([{ ticket: expect.objectContaining({ id: 'late' }), late: true }])
    const triggers = store.listTriggers('scheduler')
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.payload).toMatchObject({ ticketId: 'late', late: true })
  })

  it('does not fire before the due time; fires on time once it passes', () => {
    store.upsertTicket(ticket({ id: 'future', nextRunAt: new Date(currentMs + 5_000).toISOString() }))
    const dispatcher = fakeDispatcher()
    const scheduler = makeScheduler(dispatcher)
    scheduler.start()

    let stats = scheduler.tick()
    expect(stats.firedOneShots).toBe(0)
    expect(dispatcher.fired).toHaveLength(0)

    currentMs += 5_000
    stats = scheduler.tick()
    expect(stats.firedOneShots).toBe(1)
    expect(stats.lateOneShots).toBe(0)
    expect(dispatcher.fired[0]!.late).toBe(false)
    expect(store.getTicket('future')!.state).toBe('working')
  })

  it('never re-fires a fired one-shot on subsequent ticks', () => {
    store.upsertTicket(ticket({ id: 'once', nextRunAt: '2026-11-05T09:00:00.000Z' }))
    const dispatcher = fakeDispatcher()
    const scheduler = makeScheduler(dispatcher)
    scheduler.start()

    const second = scheduler.tick()

    expect(second.firedOneShots).toBe(0)
    expect(dispatcher.fired).toHaveLength(1)
  })

  it('defers without side effects when no slot is free', () => {
    store.upsertTicket(ticket({ id: 'queued', nextRunAt: '2026-11-05T09:00:00.000Z' }))
    const dispatcher = fakeDispatcher({ free: 0 })
    const scheduler = makeScheduler(dispatcher)

    const stats = scheduler.start()

    expect(stats.deferredNoSlot).toBe(1)
    const reloaded = store.getTicket('queued')!
    expect(reloaded.state).toBe('pending')
    expect(reloaded.nextRunAt).toBe('2026-11-05T09:00:00.000Z')
    expect(store.listTriggers('scheduler')).toHaveLength(0)

    // slot frees up → the very next tick fires it
    dispatcher.canDispatch = () => true
    expect(scheduler.tick().firedOneShots).toBe(1)
  })
})

describe('scheduler: periodic tickets', () => {
  it('fires the due round and advances nextRunAt one interval', () => {
    const due = new Date(currentMs - 1_000).toISOString()
    store.upsertTicket(ticket({ id: 'loop', period: { intervalMs: HOUR }, nextRunAt: due }))
    const dispatcher = fakeDispatcher()

    const stats = makeScheduler(dispatcher).start()

    // started 1s past the anchor — a running-process tick, not a restart gap
    expect(stats.firedPeriodic).toBe(1)
    expect(stats.skippedPeriodic).toBe(0)
    const reloaded = store.getTicket('loop')!
    expect(reloaded.state).toBe('working')
    expect(reloaded.nextRunAt).toBe(new Date(Date.parse(due) + HOUR).toISOString())
    expect(dispatcher.fired[0]!.late).toBe(false)

    // round completes → periodic ticket returns to pending for the next round
    transitionTicket(store, reloaded, 'pending')
    expect(store.getTicket('loop')!.state).toBe('pending')
  })

  it('skips every missed round on startup and continues from the next future slot', () => {
    // anchor 3.5h ago with a 1h interval: 3 rounds missed, next in 0.5h
    const due = new Date(currentMs - 3.5 * HOUR).toISOString()
    store.upsertTicket(ticket({ id: 'loop', period: { intervalMs: HOUR }, nextRunAt: due }))
    const dispatcher = fakeDispatcher()

    const stats = makeScheduler(dispatcher).start()

    expect(stats.skippedPeriodic).toBe(1)
    expect(stats.firedPeriodic).toBe(0)
    expect(dispatcher.fired).toHaveLength(0)
    const reloaded = store.getTicket('loop')!
    expect(reloaded.state).toBe('pending')
    expect(reloaded.nextRunAt).toBe(new Date(currentMs + 0.5 * HOUR).toISOString())
    expect(store.listTriggers('scheduler')).toHaveLength(0)
  })

  it('does not double-fire while a round is working', () => {
    const due = new Date(currentMs - 1_000).toISOString()
    store.upsertTicket(ticket({ id: 'loop', period: { intervalMs: HOUR }, nextRunAt: due }))
    const dispatcher = fakeDispatcher()
    const scheduler = makeScheduler(dispatcher)
    scheduler.start()

    const second = scheduler.tick()

    expect(second.firedPeriodic).toBe(0)
    expect(dispatcher.fired).toHaveLength(1)
  })
})

describe('scheduler: inert mode and lifecycle', () => {
  it('stays inert without a dispatcher, warning only once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.upsertTicket(ticket({ id: 'idle', nextRunAt: '2026-11-05T09:00:00.000Z' }))
    const scheduler = makeScheduler()

    const stats = scheduler.start()
    scheduler.tick()

    expect(stats.firedOneShots).toBe(0)
    expect(store.getTicket('idle')!.state).toBe('pending')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('no dispatcher configured')
  })

  it('stops polling on stop()', () => {
    vi.useFakeTimers()
    try {
      const scheduler = makeScheduler(fakeDispatcher())
      scheduler.start()
      expect(vi.getTimerCount()).toBe(1)
      scheduler.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a throwing dispatcher error propagate; the ticket is already transitioned', () => {
    store.upsertTicket(ticket({ id: 'boom', nextRunAt: '2026-11-05T09:00:00.000Z' }))
    const dispatcher: TicketDispatcher = {
      canDispatch: () => true,
      dispatch: () => {
        throw new Error('spawn failed')
      },
    }
    const scheduler = makeScheduler(dispatcher)

    // the tick itself propagates; the interval wrapper catches (fake-timer check below)
    expect(() => scheduler.tick()).toThrow('spawn failed')
    // ticket already transitioned — the B4 dispatcher owns the failure surface
    expect(store.getTicket('boom')!.state).toBe('working')
  })
})
