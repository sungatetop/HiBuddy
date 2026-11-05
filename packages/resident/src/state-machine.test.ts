import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ticket } from './domain.ts'
import { Store } from './store.ts'
import { canTransition, transitionTicket, TransitionError } from './state-machine.ts'

const NOW = '2026-11-05T12:00:00.000Z'

let dir: string
let store: Store

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-state-machine-'))
  store = Store.open(dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('canTransition (§3.1 edge matrix)', () => {
  it('allows the forward lifecycle edges', () => {
    expect(canTransition('pending', 'working')).toBe(true)
    expect(canTransition('working', 'awaiting_approval')).toBe(true)
    expect(canTransition('awaiting_approval', 'working')).toBe(true)
    expect(canTransition('working', 'completed')).toBe(true)
    expect(canTransition('working', 'failed')).toBe(true)
    expect(canTransition('failed', 'pending')).toBe(true)
  })

  it('allows user stop from every non-terminal state', () => {
    for (const from of ['pending', 'working', 'awaiting_approval', 'failed'] as const) {
      expect(canTransition(from, 'stopped'), from).toBe(true)
    }
  })

  it('allows working → pending only for periodic tickets (round finished)', () => {
    expect(canTransition('working', 'pending')).toBe(false)
    expect(canTransition('working', 'pending', { intervalMs: 3_600_000 })).toBe(true)
  })

  it('rejects everything out of terminal states and backwards edges', () => {
    expect(canTransition('completed', 'pending')).toBe(false)
    expect(canTransition('stopped', 'working')).toBe(false)
    expect(canTransition('pending', 'completed')).toBe(false)
    expect(canTransition('pending', 'failed')).toBe(false)
    expect(canTransition('awaiting_approval', 'pending')).toBe(false)
    expect(canTransition('working', 'working')).toBe(false)
  })
})

describe('transitionTicket', () => {
  it('persists the transition and bumps updatedAt', () => {
    store.upsertTicket(ticket({ id: 't1' }))
    const before = store.getTicket('t1')!

    const updated = transitionTicket(store, before, 'working', { sessionId: 's1' })

    expect(updated.state).toBe('working')
    expect(updated.sessionId).toBe('s1')
    expect(updated.updatedAt >= before.updatedAt).toBe(true)
    expect(store.getTicket('t1')!.state).toBe('working')
  })

  it('clears the schedule index and interrupted flag on terminal states', () => {
    store.upsertTicket(
      ticket({ id: 't2', nextRunAt: '2026-11-06T00:00:00.000Z', interrupted: true }),
    )
    const updated = transitionTicket(store, store.getTicket('t2')!, 'stopped')

    expect(updated.nextRunAt).toBeNull()
    expect(updated.interrupted).toBe(false)
  })

  it('clears the interrupted flag when a ticket becomes pending again (retry)', () => {
    store.upsertTicket(ticket({ id: 't3', state: 'failed', interrupted: false }))
    store.upsertTicket(ticket({ id: 't4', state: 'failed' }))
    const updated = transitionTicket(store, store.getTicket('t4')!, 'pending')

    expect(updated.interrupted).toBe(false)
  })

  it('throws TransitionError on an illegal edge without touching the store', () => {
    store.upsertTicket(ticket({ id: 't5', state: 'completed' }))
    const before = store.getTicket('t5')!

    expect(() => transitionTicket(store, before, 'working')).toThrow(TransitionError)
    expect(store.getTicket('t5')!.state).toBe('completed')
  })

  it('rejects working → pending for one-shot tickets even through the store path', () => {
    store.upsertTicket(ticket({ id: 't6', state: 'working' }))
    expect(() => transitionTicket(store, store.getTicket('t6')!, 'pending')).toThrow(
      TransitionError,
    )
  })

  it('permits working → pending for periodic tickets (round completed)', () => {
    store.upsertTicket(
      ticket({ id: 't7', state: 'working', period: { intervalMs: 60_000 } }),
    )
    const updated = transitionTicket(store, store.getTicket('t7')!, 'pending', {
      nextRunAt: NOW,
    })

    expect(updated.state).toBe('pending')
    expect(updated.nextRunAt).toBe(NOW)
  })
})
