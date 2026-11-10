import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILENAME, Store, SCHEMA_VERSION, StoreError } from './store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Store.open', () => {
  it('creates the database file and stamps the current schema version', () => {
    const store = Store.open(dir)
    try {
      expect(existsSync(join(dir, 'orchestrator.sqlite'))).toBe(true)
      expect(store.schemaVersion()).toBe(SCHEMA_VERSION)
    } finally {
      store.close()
    }
  })

  it('is idempotent — reopening a current database keeps the version', () => {
    const first = Store.open(dir)
    first.close()
    const second = Store.open(dir)
    try {
      expect(second.schemaVersion()).toBe(SCHEMA_VERSION)
    } finally {
      second.close()
    }
  })

  it('refuses to open a database written by a newer schema', () => {
    const first = Store.open(dir)
    first.db.exec('UPDATE schema_version SET version = 999')
    first.close()
    expect(() => Store.open(dir)).toThrow(StoreError)
    expect(() => Store.open(dir)).toThrow(/newer than this build/)
  })
})

describe('tickets', () => {
  it('round-trips a one-shot ticket with all optional fields', () => {
    const store = Store.open(dir)
    try {
      const ticket = {
        id: 't1',
        goal: '整理下载目录',
        mandate: 'explicit' as const,
        origin: 'user',
        state: 'pending' as const,
        nextRunAt: '2026-11-06T10:00:00.000Z',
        workspace: 'D:\\ProjectA',
        createdAt: '2026-11-05T00:00:00.000Z',
        updatedAt: '2026-11-05T00:00:00.000Z',
      }
      store.upsertTicket(ticket)
      expect(store.getTicket('t1')).toEqual(ticket)
      expect(store.listTickets('pending')).toHaveLength(1)
      expect(store.listTickets('working')).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('updates state without duplicating rows and keeps createdAt', () => {
    const store = Store.open(dir)
    try {
      store.upsertTicket({
        id: 't2',
        goal: 'g',
        mandate: 'explicit',
        origin: 'user',
        state: 'pending',
        createdAt: '2026-11-05T00:00:00.000Z',
        updatedAt: '2026-11-05T00:00:00.000Z',
      })
      store.upsertTicket({
        id: 't2',
        goal: 'g',
        mandate: 'explicit',
        origin: 'user',
        state: 'working',
        sessionId: 'session-9',
        interrupted: true,
        createdAt: '2026-11-05T00:00:00.000Z',
        updatedAt: '2026-11-05T00:00:00.000Z',
      })
      const reloaded = store.getTicket('t2')!
      expect(reloaded.state).toBe('working')
      expect(reloaded.sessionId).toBe('session-9')
      expect(reloaded.interrupted).toBe(true)
      expect(reloaded.createdAt).toBe('2026-11-05T00:00:00.000Z')
      expect(store.listTickets()).toHaveLength(1)
    } finally {
      store.close()
    }
  })
})

describe('ticket_runs', () => {
  it('records an open run and finishes it with an outcome', () => {
    const store = Store.open(dir)
    try {
      const runId = store.startRun('t1', '2026-11-05T01:00:00.000Z')
      expect(store.listRuns('t1')[0]!.finishedAt).toBeNull()
      store.finishRun(runId, '2026-11-05T01:05:00.000Z', 'ok', 'done')
      const run = store.listRuns('t1')[0]!
      expect(run.finishedAt).toBe('2026-11-05T01:05:00.000Z')
      expect(run.outcome).toBe('ok')
      expect(run.detail).toBe('done')
    } finally {
      store.close()
    }
  })
})

describe('sources and triggers', () => {
  it('round-trips a source instance including cursor', () => {
    const store = Store.open(dir)
    try {
      store.upsertSource({
        id: 'sched-1',
        kind: 'scheduler',
        enabled: true,
        config: { at: '2026-11-06T10:00:00.000Z' },
        cursor: { lastFiredAt: '2026-11-05T00:00:00.000Z' },
        nextRunAt: '2026-11-06T10:00:00.000Z',
      })
      const source = store.getSource('sched-1')!
      expect(source.kind).toBe('scheduler')
      expect(source.enabled).toBe(true)
      expect(source.cursor).toEqual({ lastFiredAt: '2026-11-05T00:00:00.000Z' })
      source.enabled = false
      source.degraded = true
      store.upsertSource(source)
      expect(store.getSource('sched-1')!.enabled).toBe(false)
      expect(store.getSource('sched-1')!.degraded).toBe(true)
      expect(store.listSources()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('stores and lists triggers chronologically, filterable by source', () => {
    const store = Store.open(dir)
    try {
      store.saveTrigger({ id: 'tr2', sourceId: 'm1', at: '2026-11-05T02:00:00.000Z', payload: { hit: true } })
      store.saveTrigger({ id: 'tr1', sourceId: 's1', at: '2026-11-05T01:00:00.000Z', payload: null, untrusted: true })
      expect(store.listTriggers().map((t) => t.id)).toEqual(['tr1', 'tr2'])
      expect(store.listTriggers('m1')).toHaveLength(1)
      expect(store.listTriggers('s1')[0]!.untrusted).toBe(true)
    } finally {
      store.close()
    }
  })
})

describe('messages', () => {
  const base = {
    id: 'n1',
    direction: 'out' as const,
    kind: 'report' as const,
    idempotencyKey: 't1|report|abc',
    title: '任务完成',
    text: '整理完成',
    refs: { ticketId: 't1' },
    read: false,
    delivered: false,
    createdAt: '2026-11-05T00:00:00.000Z',
  }

  it('drops duplicate idempotency keys', () => {
    const store = Store.open(dir)
    try {
      expect(store.addMessage(base)).toBe(true)
      expect(store.addMessage({ ...base, id: 'n2' })).toBe(false)
      expect(store.listMessages()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('supports read flags and re-arming delivery', () => {
    const store = Store.open(dir)
    try {
      store.addMessage(base)
      store.addMessage({ ...base, id: 'n3', idempotencyKey: 'k3', kind: 'approval', refs: { ticketId: 't9' } })
      store.markMessageRead('n1')
      expect(store.listMessages({ unreadOnly: true })).toHaveLength(1)
      const reArmed = store.redeliverMessages((m) => m.kind === 'approval')
      expect(reArmed).toBe(1)
      store.markAllMessagesRead()
      expect(store.listMessages({ unreadOnly: true })).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('round-trips message attachments and serves them by id', () => {
    const store = Store.open(dir)
    try {
      store.addMessage({
        ...base,
        attachments: [
          { id: 'att_1', kind: 'image', name: 'chart.png', path: 'D:\\ws\\chart.png', mime: 'image/png', size: 16 },
          { id: 'att_2', kind: 'video', name: 'clip.mp4', url: 'https://example.com/clip.mp4' },
        ],
      })
      const [message] = store.listMessages()
      expect(message!.attachments).toHaveLength(2)
      expect(message!.attachments![0]).toMatchObject({ id: 'att_1', kind: 'image', size: 16 })
      expect(message!.attachments![1]).toMatchObject({ id: 'att_2', url: 'https://example.com/clip.mp4' })
      expect(store.getAttachment('att_1')).toMatchObject({ messageId: 'n1', name: 'chart.png' })
      expect(store.getAttachment('nope')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('does not write attachments for a duplicate message', () => {
    const store = Store.open(dir)
    try {
      store.addMessage(base)
      const duplicate = store.addMessage({
        ...base,
        attachments: [{ id: 'att_x', kind: 'file', name: 'a.txt' }],
      })
      expect(duplicate).toBe(false)
      expect(store.getAttachment('att_x')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('round-trips structured data (schema v5) and keeps plain rows dataless', () => {
    const store = Store.open(dir)
    try {
      store.addMessage({
        ...base,
        data: {
          outcome: 'completed',
          runId: 7,
          startedAt: '2026-11-10T08:00:00.000Z',
          finishedAt: '2026-11-10T08:00:48.000Z',
          durationMs: 48_000,
          artifacts: [],
        },
      })
      store.addMessage({ ...base, id: 'n4', idempotencyKey: 'k4', kind: 'text', text: 'hi' })
      const withData = store.listMessages()[1]!
      const plain = store.listMessages()[0]!
      expect(withData.data).toMatchObject({ outcome: 'completed', runId: 7, artifacts: [] })
      expect(plain.data).toBeUndefined()
    } finally {
      store.close()
    }
  })
})

describe('worker sessions and settings', () => {
  it('upserts one worker session per ticket', () => {
    const store = Store.open(dir)
    try {
      store.upsertWorkerSession({ ticketId: 't1', sessionId: 's1', state: 'working' })
      store.upsertWorkerSession({ ticketId: 't1', sessionId: 's1', state: 'awaiting_approval', lastReport: '需要确认' })
      const ws = store.getWorkerSession('t1')!
      expect(ws.state).toBe('awaiting_approval')
      expect(ws.lastReport).toBe('需要确认')
      expect(store.listWorkerSessions()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('persists settings as JSON values', () => {
    const store = Store.open(dir)
    try {
      store.setSetting('quietHours', { start: '23:00', end: '08:00' })
      expect(store.getSetting<{ start: string; end: string }>('quietHours')).toEqual({ start: '23:00', end: '08:00' })
    } finally {
      store.close()
    }
  })
})

describe('transaction', () => {
  it('rolls back on failure so partial writes never survive', () => {
    const store = Store.open(dir)
    try {
      expect(() =>
        store.transaction(() => {
          store.setSetting('a', 1)
          throw new Error('boom')
        }),
      ).toThrow('boom')
      expect(store.getSetting('a')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('nests via savepoints', () => {
    const store = Store.open(dir)
    try {
      store.transaction(() => {
        store.setSetting('outer', 1)
        store.transaction(() => {
          store.setSetting('inner', 2)
        })
      })
      expect(store.getSetting('outer')).toBe(1)
      expect(store.getSetting('inner')).toBe(2)
    } finally {
      store.close()
    }
  })
})

describe('v1 → v2 migration', () => {
  it('turns notification rows into outbound messages and drops the old table', () => {
    const db = new DatabaseSync(join(dir, DB_FILENAME))
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (1);
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY, ticket_id TEXT, type TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, body TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0, delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO notifications (id, ticket_id, type, idempotency_key, title, body, read, delivered, created_at)
      VALUES ('n1', 't1', 'result', 'k1', '任务完成', '整理完成', 0, 1, '2026-11-05T00:00:00.000Z');
      INSERT INTO notifications (id, ticket_id, type, idempotency_key, title, body, read, delivered, created_at)
      VALUES ('n2', 't2', 'awaiting_approval', 'k2', '待批', '需要确认', 0, 0, '2026-11-05T00:01:00.000Z');
    `)
    db.close()

    const store = Store.open(dir)
    try {
      expect(store.schemaVersion()).toBe(SCHEMA_VERSION)
      const messages = store.listMessages({ oldestFirst: true })
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ direction: 'out', kind: 'report', text: '整理完成', delivered: true })
      expect(messages[1]).toMatchObject({ direction: 'out', kind: 'approval', text: '需要确认' })
      const old = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'")
        .get()
      expect(old).toBeUndefined()
    } finally {
      store.close()
    }
  })
})

describe('v4 → v5 migration (perception B12′)', () => {
  it('adds the messages.data column, preserves old rows and round-trips new data', () => {
    const db = new DatabaseSync(join(dir, DB_FILENAME))
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (4);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT,
        text TEXT NOT NULL,
        ticket_id TEXT,
        session_id TEXT,
        source_id TEXT,
        reply_to TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        read INTEGER NOT NULL DEFAULT 0,
        delivered INTEGER NOT NULL DEFAULT 0,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO messages (id, direction, kind, title, text, ticket_id, idempotency_key, read, delivered, created_at)
      VALUES ('m1', 'in', 'receipt', '任务完成', '整理完成', 't1', 'receipt:t1:1', 0, 1, '2026-11-10T08:00:00.000Z');
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT,
        url TEXT,
        mime TEXT,
        size INTEGER,
        created_at TEXT NOT NULL
      );
    `)
    db.close()

    const store = Store.open(dir)
    try {
      expect(store.schemaVersion()).toBe(SCHEMA_VERSION)
      const [old] = store.listMessages()
      expect(old!.idempotencyKey).toBe('receipt:t1:1')
      expect(old!.data).toBeUndefined()

      // A v5 row hydrates its data JSON.
      store.addMessage({
        id: 'm2',
        direction: 'in',
        kind: 'receipt',
        refs: { ticketId: 't1', sessionId: 's1' },
        text: '第二轮摘要相同',
        idempotencyKey: 'receipt:t1:2',
        read: false,
        delivered: true,
        createdAt: '2026-11-10T09:00:00.000Z',
        data: {
          outcome: 'completed',
          runId: 2,
          startedAt: '2026-11-10T09:00:00.000Z',
          finishedAt: '2026-11-10T09:01:00.000Z',
          durationMs: 60_000,
          artifacts: [],
        },
      })
      expect(store.listMessages()[0]!.data).toMatchObject({ outcome: 'completed', runId: 2, artifacts: [] })
    } finally {
      store.close()
    }
  })
})
