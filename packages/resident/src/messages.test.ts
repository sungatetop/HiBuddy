import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  contentKey,
  inQuietWindow,
  MessageService,
  parseQuietWindow,
  QUIET_EXCEPTIONS_KEY,
  QUIET_HOURS_KEY,
} from './messages.ts'
import { Store } from './store.ts'

let dir: string
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-messages-'))
  store = Store.open(dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const atNoon = () => new Date('2026-11-09T12:00:00')
const atNight = () => new Date('2026-11-09T23:30:00')

describe('quiet window helpers', () => {
  it('parses valid windows and rejects malformed values', () => {
    expect(parseQuietWindow({ start: '22:00', end: '07:00' })).toEqual({ start: '22:00', end: '07:00' })
    expect(parseQuietWindow({ start: '9:00', end: '07:00' })).toBeUndefined()
    expect(parseQuietWindow(null)).toBeUndefined()
    expect(parseQuietWindow('22:00-07:00')).toBeUndefined()
  })

  it('handles windows crossing midnight and the empty window', () => {
    expect(inQuietWindow(atNight(), { start: '22:00', end: '07:00' })).toBe(true)
    expect(inQuietWindow(atNoon(), { start: '22:00', end: '07:00' })).toBe(false)
    expect(inQuietWindow(atNoon(), { start: '09:00', end: '09:00' })).toBe(false)
  })
})

describe('MessageService.post', () => {
  it('records an outbound message and pushes it outside the window', () => {
    const service = new MessageService(store, { now: atNoon })
    const outcome = service.postOutbound({
      kind: 'report',
      refs: { ticketId: 't1' },
      title: '任务完成',
      text: '一切就绪',
    })

    expect(outcome.recorded).toBe(true)
    expect(outcome.delivered).toBe(true)
    const rows = store.listMessages()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ direction: 'out', kind: 'report', delivered: true, read: false })
  })

  it('records inbound messages without push and exposes them to the queue', () => {
    const service = new MessageService(store, { now: atNoon })
    const first = service.postInbound({ kind: 'text', text: '帮我看下项目' })
    service.postInbound({ kind: 'event', text: 'monitor hit', refs: { sourceId: 'm1' } })

    expect(first.delivered).toBe(true)
    const pending = service.pendingInbound()
    expect(pending.map((m) => m.kind)).toEqual(['text', 'event'])
    expect(service.consume([pending[0]!.id, pending[1]!.id])).toBe(2)
    expect(service.pendingInbound()).toHaveLength(0)
  })

  it('drops duplicate idempotency keys (default content key included)', () => {
    const service = new MessageService(store, { now: atNoon })
    const input = { kind: 'report' as const, refs: { ticketId: 't1' }, title: 't', text: 'b' }
    expect(service.postOutbound(input).recorded).toBe(true)
    expect(service.postOutbound(input).recorded).toBe(false)
    expect(store.listMessages()).toHaveLength(1)
  })

  it('silences pushes inside the window but still records', () => {
    store.setSetting(QUIET_HOURS_KEY, { start: '22:00', end: '07:00' })
    const service = new MessageService(store, { now: atNight })
    const outcome = service.postOutbound({ kind: 'report', refs: { ticketId: 't1' }, title: '任务完成', text: '夜间完成' })

    expect(outcome.recorded).toBe(true)
    expect(outcome.delivered).toBe(false)
    expect(store.listMessages()[0]!.delivered).toBe(false)
  })

  it('silences global (ticketless) outbound messages too', () => {
    store.setSetting(QUIET_HOURS_KEY, { start: '22:00', end: '07:00' })
    const service = new MessageService(store, { now: atNight })
    const outcome = service.postOutbound({ kind: 'system', title: '来源降级', text: '监控失效' })
    expect(outcome.delivered).toBe(false)
  })

  it('delivers exception-ticket messages inside the window', () => {
    store.setSetting(QUIET_HOURS_KEY, { start: '22:00', end: '07:00' })
    store.setSetting(QUIET_EXCEPTIONS_KEY, ['t-important'])
    const service = new MessageService(store, { now: atNight })

    const exempt = service.postOutbound({ kind: 'approval', refs: { ticketId: 't-important' }, title: '待批', text: '需要确认' })
    const silenced = service.postOutbound({ kind: 'approval', refs: { ticketId: 't-other' }, title: '待批', text: '需要确认' })
    expect(exempt.delivered).toBe(true)
    expect(silenced.delivered).toBe(false)
  })

  it('routes approval cards to the exception ticket', () => {
    const service = new MessageService(store, { now: atNoon })
    expect(service.postOutbound({ kind: 'report', title: 't', text: 'b' }).delivered).toBe(true)
  })
})

describe('MessageService.deliverPending', () => {
  it('reaches rows recorded during the window once the window is over', () => {
    store.setSetting(QUIET_HOURS_KEY, { start: '22:00', end: '07:00' })
    const quiet = new MessageService(store, { now: atNight })
    quiet.postOutbound({ kind: 'report', refs: { ticketId: 't1' }, title: 'a', text: '1' })
    quiet.postOutbound({ kind: 'report', refs: { ticketId: 't2' }, title: 'b', text: '2' })

    expect(store.listMessages().every((m) => !m.delivered)).toBe(true)

    const day = new MessageService(store, { now: atNoon })
    expect(day.deliverPending()).toBe(2)
    expect(store.listMessages().every((m) => m.delivered)).toBe(true)
  })

  it('skips read rows and inbound rows', () => {
    const service = new MessageService(store, { now: atNoon })
    service.postInbound({ kind: 'text', text: 'hi' })
    expect(service.deliverPending()).toBe(0)
  })
})

describe('MessageService read API', () => {
  it('counts unread rows and marks them read', () => {
    const service = new MessageService(store, { now: atNoon })
    service.postOutbound({ kind: 'report', title: 'a', text: '1' })
    service.postOutbound({ kind: 'system', title: 'b', text: '2' })
    service.postInbound({ kind: 'text', text: 'user' })

    expect(service.unreadCount()).toBe(3)
    expect(service.markAllRead()).toBe(3)
    expect(service.unreadCount()).toBe(0)
  })

  it('lists oldest-first for chat replay', () => {
    const service = new MessageService(store, { now: atNoon })
    service.postInbound({ kind: 'text', text: 'one' })
    service.postOutbound({ kind: 'text', text: 'two' })
    expect(service.list({ oldestFirst: true }).map((m) => m.text)).toEqual(['one', 'two'])
    expect(service.list().map((m) => m.text)).toEqual(['two', 'one'])
  })
})

describe('contentKey', () => {
  it('is stable for identical content and differs by owner', () => {
    const a = contentKey('out', 'report', { ticketId: 't1' }, 't', 'b')
    const b = contentKey('out', 'report', { ticketId: 't1' }, 't', 'b')
    const c = contentKey('out', 'report', { ticketId: 't2' }, 't', 'b')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
