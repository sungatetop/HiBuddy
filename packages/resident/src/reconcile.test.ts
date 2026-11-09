import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ticket } from './domain.ts'
import { reconcile } from './reconcile.ts'
import { Store } from './store.ts'

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
  dir = mkdtempSync(join(tmpdir(), 'resident-reconcile-'))
  store = Store.open(dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('reconcile', () => {
  it('marks working tickets interrupted and closes their open run', async () => {
    store.upsertTicket(ticket({ id: 't1', state: 'working' }))
    store.startRun('t1', '2026-11-05T10:00:00.000Z')

    const summary = await reconcile(store, NOW)

    expect(summary.resumed).toBe(0)
    expect(summary.interrupted).toBe(1)
    const reloaded = store.getTicket('t1')!
    expect(reloaded.interrupted).toBe(true)
    const run = store.listRuns('t1')[0]!
    expect(run.finishedAt).toBe(NOW)
    expect(run.outcome).toBe('interrupted')
  })

  it('prefers the resume hook; a refusing or throwing hook falls back to interrupted', async () => {
    store.upsertTicket(ticket({ id: 'resumable', state: 'working' }))
    store.upsertTicket(ticket({ id: 'refusing', state: 'working' }))
    store.upsertTicket(ticket({ id: 'throwing', state: 'working' }))

    const summary = await reconcile(store, NOW, {
      resumeWorker: (t) => {
        if (t.id === 'refusing') return false
        if (t.id === 'throwing') throw new Error('session gone')
        return true
      },
    })

    expect(summary.resumed).toBe(1)
    expect(summary.interrupted).toBe(2)
    expect(store.getTicket('resumable')!.interrupted).toBeUndefined()
    expect(store.getTicket('refusing')!.interrupted).toBe(true)
    expect(store.getTicket('throwing')!.interrupted).toBe(true)
  })

  it('closes the interrupted open run even when the resume hook succeeds', async () => {
    store.upsertTicket(ticket({ id: 'resumable', state: 'working' }))
    store.startRun('resumable', '2026-11-05T10:00:00.000Z')

    const summary = await reconcile(store, NOW, { resumeWorker: () => true })

    expect(summary.resumed).toBe(1)
    // the physically interrupted round is closed up front; the resumed round
    // (started by the hook) opens its own fresh run afterwards
    const runs = store.listRuns('resumable')
    expect(runs[0]!.finishedAt).toBe(NOW)
    expect(runs[0]!.outcome).toBe('interrupted')
  })

  it('keeps awaiting_approval tickets and re-arms their unread approval cards', async () => {
    store.upsertTicket(ticket({ id: 't2', state: 'awaiting_approval' }))
    store.addMessage({
      id: 'n1',
      direction: 'out',
      kind: 'approval',
      idempotencyKey: 'k1',
      title: '待批',
      text: 'b',
      refs: { ticketId: 't2' },
      read: false,
      delivered: true,
      createdAt: NOW,
    })

    const summary = await reconcile(store, NOW)

    expect(summary.awaitingApproval).toBe(1)
    expect(summary.reNotified).toBe(1)
    const message = store.listMessages()[0]!
    expect(message.delivered).toBe(false)
    expect(message.read).toBe(false)
  })

  it('counts missed one-shot pending tickets without rewriting them', async () => {
    store.upsertTicket(ticket({ id: 'missed', state: 'pending', nextRunAt: '2026-11-05T09:00:00.000Z' }))
    store.upsertTicket(ticket({ id: 'future', state: 'pending', nextRunAt: '2026-11-05T20:00:00.000Z' }))
    store.upsertTicket(ticket({ id: 'periodic', state: 'pending', period: { intervalMs: 3_600_000 }, nextRunAt: '2026-11-05T09:00:00.000Z' }))

    const summary = await reconcile(store, NOW)

    expect(summary.missedOneShots).toBe(1)
    expect(store.getTicket('missed')!.nextRunAt).toBe('2026-11-05T09:00:00.000Z')
  })

  it('ignores terminal tickets entirely', async () => {
    store.upsertTicket(ticket({ id: 'done', state: 'completed' }))
    store.upsertTicket(ticket({ id: 'halted', state: 'stopped' }))

    const summary = await reconcile(store, NOW)

    expect(summary).toEqual({ resumed: 0, interrupted: 0, awaitingApproval: 0, reNotified: 0, missedOneShots: 0 })
  })
})
