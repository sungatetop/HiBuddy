import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NotificationService,
  QUIET_EXCEPTIONS_KEY,
  QUIET_HOURS_KEY,
  contentKey,
  inQuietWindow,
  parseQuietWindow,
} from './notifications.ts'
import { Store } from './store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-notifications-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Local-time clock fixtures (the window math is wall-clock, not UTC). */
const atNoon = (): Date => new Date(2026, 10, 9, 12, 0, 0)
const atNight = (): Date => new Date(2026, 10, 9, 23, 30, 0)

describe('parseQuietWindow', () => {
  it('accepts a well-formed window', () => {
    expect(parseQuietWindow({ start: '22:00', end: '07:00' })).toEqual({ start: '22:00', end: '07:00' })
  })

  it('tolerates absent, null, and malformed values', () => {
    expect(parseQuietWindow(undefined)).toBeUndefined()
    expect(parseQuietWindow(null)).toBeUndefined()
    expect(parseQuietWindow('22:00-07:00')).toBeUndefined()
    expect(parseQuietWindow({ start: '22:00' })).toBeUndefined()
    expect(parseQuietWindow({ start: 2200, end: 700 })).toBeUndefined()
    expect(parseQuietWindow({ start: '25:00', end: '07:00' })).toBeUndefined()
    expect(parseQuietWindow({ start: '22:00', end: '7:0' })).toBeUndefined()
  })
})

describe('inQuietWindow', () => {
  it('is half-open [start, end) inside one day', () => {
    const window = { start: '09:00', end: '17:00' }
    expect(inQuietWindow(new Date(2026, 10, 9, 8, 59), window)).toBe(false)
    expect(inQuietWindow(new Date(2026, 10, 9, 9, 0), window)).toBe(true)
    expect(inQuietWindow(new Date(2026, 10, 9, 16, 59), window)).toBe(true)
    expect(inQuietWindow(new Date(2026, 10, 9, 17, 0), window)).toBe(false)
  })

  it('crosses midnight when end is earlier than start', () => {
    const window = { start: '22:00', end: '07:00' }
    expect(inQuietWindow(new Date(2026, 10, 9, 23, 30), window)).toBe(true)
    expect(inQuietWindow(new Date(2026, 10, 9, 0, 0), window)).toBe(true)
    expect(inQuietWindow(new Date(2026, 10, 9, 6, 59), window)).toBe(true)
    expect(inQuietWindow(new Date(2026, 10, 9, 7, 0), window)).toBe(false)
    expect(inQuietWindow(new Date(2026, 10, 9, 12, 0), window)).toBe(false)
  })

  it('treats start === end as an empty window', () => {
    const window = { start: '09:00', end: '09:00' }
    expect(inQuietWindow(new Date(2026, 10, 9, 9, 0), window)).toBe(false)
    expect(inQuietWindow(new Date(2026, 10, 9, 3, 0), window)).toBe(false)
  })
})

describe('contentKey', () => {
  it('is stable for identical content and scoped by ticket', () => {
    expect(contentKey('result', 't1', '标题', '正文')).toBe(contentKey('result', 't1', '标题', '正文'))
    expect(contentKey('result', 't1', '标题', '正文')).not.toBe(contentKey('result', 't2', '标题', '正文'))
    expect(contentKey('result', null, '标题', '正文')).toBe(contentKey('result', undefined, '标题', '正文'))
    expect(contentKey('result', null, '标题', '正文')).toMatch(/^global:result:[0-9a-f]{16}$/)
    expect(contentKey('system', null, '标题', '正文')).not.toBe(contentKey('result', null, '标题', '正文'))
  })
})

describe('NotificationService.notify', () => {
  it('persists first, then delivers outside the quiet window', () => {
    const store = Store.open(dir)
    try {
      const service = new NotificationService(store, { now: atNoon })
      const outcome = service.notify({ type: 'result', title: '任务完成', body: '一切就绪', ticketId: 't1' })
      expect(outcome.recorded).toBe(true)
      expect(outcome.delivered).toBe(true)
      const rows = store.listNotifications()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.delivered).toBe(true)
      expect(rows[0]!.read).toBe(false)
      expect(rows[0]!.idempotencyKey).toBe(contentKey('result', 't1', '任务完成', '一切就绪'))
    } finally {
      store.close()
    }
  })

  it('drops duplicates by idempotency key', () => {
    const store = Store.open(dir)
    try {
      const service = new NotificationService(store, { now: atNoon })
      const input = { type: 'report' as const, title: '观察', body: '命中', idempotencyKey: 'fixed-key' }
      expect(service.notify(input).recorded).toBe(true)
      const second = service.notify(input)
      expect(second.recorded).toBe(false)
      expect(second.delivered).toBe(false)
      expect(second.notification).toBeUndefined()
      expect(store.listNotifications()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('records but does not deliver inside the quiet window', () => {
    const store = Store.open(dir)
    try {
      store.setSetting(QUIET_HOURS_KEY, { start: '22:00', end: '07:00' })
      const service = new NotificationService(store, { now: atNight })
      const outcome = service.notify({ type: 'result', title: '任务完成', body: '夜间完成', ticketId: 't1' })
      expect(outcome.recorded).toBe(true)
      expect(outcome.delivered).toBe(false)
      expect(outcome.notification?.delivered).toBe(false)
      expect(store.listNotifications()[0]!.delivered).toBe(false)
    } finally {
      store.close()
    }
  })

  it('silences ticketless (global) notifications inside the window too', () => {
    const store = Store.open(dir)
    try {
      store.setSetting(QUIET_HOURS_KEY, { start: '22:00', end: '07:00' })
      const service = new NotificationService(store, { now: atNight })
      const outcome = service.notify({ type: 'system', title: '来源降级', body: '监控失效' })
      expect(outcome.recorded).toBe(true)
      expect(outcome.delivered).toBe(false)
    } finally {
      store.close()
    }
  })

  it('delivers exception-ticket notifications inside the window', () => {
    const store = Store.open(dir)
    try {
      store.setSetting(QUIET_HOURS_KEY, { start: '22:00', end: '07:00' })
      store.setSetting(QUIET_EXCEPTIONS_KEY, ['t-important'])
      const service = new NotificationService(store, { now: atNight })
      const exempt = service.notify({ type: 'awaiting_approval', title: '待批', body: '需要确认', ticketId: 't-important' })
      const silenced = service.notify({ type: 'awaiting_approval', title: '待批', body: '需要确认', ticketId: 't-other' })
      expect(exempt.delivered).toBe(true)
      expect(silenced.delivered).toBe(false)
    } finally {
      store.close()
    }
  })

  it('ignores a malformed quiet window instead of breaking delivery', () => {
    const store = Store.open(dir)
    try {
      store.setSetting(QUIET_HOURS_KEY, { start: 'nope', end: '07:00' })
      const service = new NotificationService(store, { now: atNight })
      expect(service.notify({ type: 'result', title: 't', body: 'b' }).delivered).toBe(true)
    } finally {
      store.close()
    }
  })
})

describe('NotificationService.deliverPending', () => {
  it('re-reaches undelivered unread rows and skips read ones', () => {
    const store = Store.open(dir)
    try {
      store.setSetting(QUIET_HOURS_KEY, { start: '22:00', end: '07:00' })
      const quiet = new NotificationService(store, { now: atNight })
      quiet.notify({ type: 'result', title: 'a', body: '1', ticketId: 't1' })
      quiet.notify({ type: 'result', title: 'b', body: '2', ticketId: 't2' })
      expect(store.listNotifications().every((n) => !n.delivered)).toBe(true)

      // One row gets read before the window closes — it must not be pushed.
      const readId = store.listNotifications()[0]!.id
      store.markNotificationRead(readId)

      const day = new NotificationService(store, { now: atNoon })
      expect(day.deliverPending()).toBe(1)
      const byId = new Map(store.listNotifications().map((n) => [n.id, n]))
      expect(byId.get(readId)!.delivered).toBe(false)
      // Re-running is a no-op: everything pending has been reached.
      expect(day.deliverPending()).toBe(0)
    } finally {
      store.close()
    }
  })

  it('keeps silenced rows pending until the window ends, while exceptions go out immediately', () => {
    const store = Store.open(dir)
    try {
      store.setSetting(QUIET_HOURS_KEY, { start: '22:00', end: '07:00' })
      store.setSetting(QUIET_EXCEPTIONS_KEY, ['t-vip'])
      const quiet = new NotificationService(store, { now: atNight })
      quiet.notify({ type: 'result', title: 'a', body: '1', ticketId: 't1' })
      // Exception tickets bypass the window straight away in notify().
      quiet.notify({ type: 'awaiting_approval', title: 'b', body: '2', ticketId: 't-vip' })

      // Nothing left to re-reach: t1 is still silenced, t-vip already went out.
      expect(new NotificationService(store, { now: atNight }).deliverPending()).toBe(0)
      const rows = store.listNotifications()
      expect(rows.find((n) => n.ticketId === 't-vip')!.delivered).toBe(true)
      expect(rows.find((n) => n.ticketId === 't1')!.delivered).toBe(false)

      // Once the window closes the silenced row is delivered by the catch-up pass.
      expect(new NotificationService(store, { now: atNoon }).deliverPending()).toBe(1)
      expect(store.listNotifications().find((n) => n.ticketId === 't1')!.delivered).toBe(true)
    } finally {
      store.close()
    }
  })
})

describe('NotificationService read API', () => {
  it('tracks unread count, markRead and markAllRead', () => {
    const store = Store.open(dir)
    try {
      const service = new NotificationService(store, { now: atNoon })
      service.notify({ type: 'result', title: 'a', body: '1' })
      service.notify({ type: 'system', title: 'b', body: '2' })
      expect(service.unreadCount()).toBe(2)

      const [first] = service.list()
      service.markRead(first!.id)
      expect(service.unreadCount()).toBe(1)
      expect(service.list({ unreadOnly: true })).toHaveLength(1)

      expect(service.markAllRead()).toBe(1)
      expect(service.unreadCount()).toBe(0)
    } finally {
      store.close()
    }
  })
})
