/**
 * Channel bridge tests (channel-message-source-design.md v3): push into the
 * butler conversation, idempotent ledger convergence across push/reconcile/
 * restart overlap, first-scan baseline, and the subscription gates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  ChannelBridge,
  extractInboundMessages,
  parseChannelConfig,
  parseChannelCursor,
  RECONCILE_WINDOW_EVENTS,
  type ChannelSessionEvent,
  type ChannelSessionReader,
} from './channel.ts'
import { MessageService } from './messages.ts'
import { Store } from './store.ts'

let dir: string
let store: Store
let now: Date

/** A user-message session event (what channel plugins append for platform text). */
function userMessage(id: string, text: string, kind = 'user'): ChannelSessionEvent {
  return {
    type: 'user/message',
    data: { id, content: [{ type: 'text', text }], source: { kind } },
  }
}

/** An unrelated event (turn markers, tool traffic) the bridge must ignore. */
function otherEvent(type: string): ChannelSessionEvent {
  return { type, data: {} }
}

/** In-memory session store mirroring the dsh session log shape. */
class FakeSessions implements ChannelSessionReader {
  private readonly sessions = new Map<string, ChannelSessionEvent[]>()

  add(sessionId: string, events: ChannelSessionEvent[] = []): void {
    this.sessions.set(sessionId, [...events])
  }

  append(sessionId: string, event: ChannelSessionEvent): void {
    const log = this.sessions.get(sessionId)
    if (log !== undefined) log.push(event)
  }

  get(sessionId: string): { seq: number; snapshotEvents(from: number, to: number): readonly ChannelSessionEvent[] } | undefined {
    const log = this.sessions.get(sessionId)
    if (log === undefined) return undefined
    return {
      seq: log.length,
      snapshotEvents: (from: number, to: number) => log.slice(from, to),
    }
  }
}

/** Fake ctx capturing the session/event handler; emit(sessionId, event) fires it. */
function fakeCtx(): { ctx: Context; emit: (sessionId: string, event: ChannelSessionEvent) => void } {
  let handler: ((session: { id: string }, event: ChannelSessionEvent) => void) | undefined
  const ctx = {
    on: vi.fn((_event: string, h: (session: { id: string }, event: ChannelSessionEvent) => void) => {
      handler = h
      return () => {
        handler = undefined
      }
    }),
  } as unknown as Context
  return {
    ctx,
    emit: (sessionId: string, event: ChannelSessionEvent) => handler?.({ id: sessionId }, event),
  }
}

/** Subscribes a channel session in the store (the butler tool's write path). */
function subscribe(sessionId: string, config: Record<string, unknown> = {}): string {
  const id = `src_${sessionId.replace(/[^a-z0-9]/gi, '_')}`
  store.upsertSource({
    id,
    kind: 'channel',
    enabled: true,
    config: { channel: 'wechat', sessionId, ...config },
  })
  return id
}

/** A bridge over the shared store/clock with the fake reader injected. */
function makeBridge(ctx: Context, sessions: FakeSessions, onInbound?: () => void): ChannelBridge {
  const ledger = new MessageService(store, { now: () => now, onInbound })
  return new ChannelBridge(ctx, store, ledger, { now: () => now, sessions })
}

function channelEvents(): ReturnType<Store['listMessages']> {
  // listMessages defaults to a 200-row page — raise it, these tests exceed it.
  return store
    .listMessages({ limit: 1000 })
    .filter((m) => m.kind === 'event' && (m.data as { code?: string })?.code === 'channel_message')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-channel-'))
  store = Store.open(dir)
  now = new Date('2026-11-13T08:00:00.000Z')
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('push path', () => {
  it('delivers a subscribed channel message to the ledger and wakes the butler pump', () => {
    const { ctx, emit } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('channel-wechat-1')
    const wake = vi.fn()
    const bridge = makeBridge(ctx, sessions, wake)
    subscribe('channel-wechat-1')

    emit('channel-wechat-1', userMessage('m1', '老板让明早交周报'))

    const rows = channelEvents()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.idempotencyKey).toBe('channel:channel-wechat-1:m1')
    expect(rows[0]!.title).toContain('wechat')
    expect(rows[0]!.text).toContain('老板让明早交周报')
    expect(rows[0]!.refs).toMatchObject({ sourceId: 'src_channel_wechat_1', sessionId: 'channel-wechat-1' })
    expect(rows[0]!.data).toMatchObject({ code: 'channel_message', untrusted: true })
    expect(wake).toHaveBeenCalledTimes(1) // ledger onInbound fired → pump wakes
  })

  it('delivers the same messageId once no matter how many paths saw it', () => {
    const { ctx, emit } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('channel-wechat-1')
    const bridge = makeBridge(ctx, sessions)
    subscribe('channel-wechat-1')

    // Push fires, then the reconcile sweep re-reads the same window (overlap).
    emit('channel-wechat-1', userMessage('m1', '第一条'))
    bridge.reconcile()

    expect(channelEvents()).toHaveLength(1)

    // A literal repeat from the platform (same platform message id) also dedupes.
    emit('channel-wechat-1', userMessage('m1', '第一条'))
    expect(channelEvents()).toHaveLength(1)

    // A different messageId is a different message — delivered.
    emit('channel-wechat-1', userMessage('m2', '第二条'))
    expect(channelEvents()).toHaveLength(2)
  })

  it('ignores sessions without a subscription', () => {
    const { ctx, emit } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('channel-wechat-x')
    const bridge = makeBridge(ctx, sessions)
    subscribe('channel-wechat-1')

    emit('channel-wechat-x', userMessage('m1', '未订阅的会话'))
    expect(store.listMessages()).toHaveLength(0)
  })

  it('never delivers synthetic injections (source.kind ≠ user)', () => {
    const { ctx, emit } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('lark-1')
    const bridge = makeBridge(ctx, sessions)
    subscribe('lark-1', { channel: 'lark' })

    emit('lark-1', userMessage('m1', '人类说的话'))
    emit('lark-1', userMessage('m2', '模型自言自语', 'assistant'))
    emit('lark-1', userMessage('m3', '工具产物', 'tool_result'))

    const rows = channelEvents()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.idempotencyKey).toBe('channel:lark-1:m1')
  })

  it('ignores non user/message events and includes the subscription condition in the envelope', () => {
    const { ctx, emit } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('onebot-7')
    const bridge = makeBridge(ctx, sessions)
    subscribe('onebot-7', { channel: 'onebot', condition: '提到“周报”时提醒我' })

    emit('onebot-7', otherEvent('turn/end'))
    emit('onebot-7', userMessage('m1', '周报模板发一下'))

    const rows = channelEvents()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toContain('周报模板发一下')
    expect(rows[0]!.text).toContain('订阅关注点：提到“周报”时提醒我')
  })

  it('stop() removes the listener', () => {
    const { ctx, emit } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('channel-wechat-1')
    const bridge = makeBridge(ctx, sessions)
    subscribe('channel-wechat-1')

    bridge.stop()
    emit('channel-wechat-1', userMessage('m1', '停止后到达'))
    expect(store.listMessages()).toHaveLength(0)
  })
})

describe('reconcile sweep', () => {
  it('records the baseline for a brand-new subscription without replaying history', () => {
    const { ctx } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('channel-wechat-1', [userMessage('old-1', '订阅前的历史消息')])
    const bridge = makeBridge(ctx, sessions)
    subscribe('channel-wechat-1')

    bridge.reconcile()
    expect(store.listMessages()).toHaveLength(0) // history never fires
    expect(parseChannelCursor(store.getSource('src_channel_wechat_1')!.cursor).lastSeq).toBe(1)

    // A message after the baseline is caught by the sweep…
    sessions.append('channel-wechat-1', userMessage('new-1', '订阅后的新消息'))
    bridge.reconcile()
    const rows = channelEvents()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.idempotencyKey).toBe('channel:channel-wechat-1:new-1')
    expect(parseChannelCursor(store.getSource('src_channel_wechat_1')!.cursor).lastSeq).toBe(2)
  })

  it('catches up messages that arrived while the bridge was down', () => {
    const { ctx } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('channel-wechat-1', [userMessage('a', 'a'), userMessage('b', 'b')])
    const bridge = makeBridge(ctx, sessions)
    subscribe('channel-wechat-1')
    bridge.reconcile() // baseline at seq 2

    // "Downtime": two messages land with no listener (the push path missed them).
    sessions.append('channel-wechat-1', userMessage('c', 'c'))
    sessions.append('channel-wechat-1', userMessage('d', 'd'))

    bridge.reconcile()
    const keys = channelEvents().map((m) => m.idempotencyKey).sort()
    expect(keys).toEqual(['channel:channel-wechat-1:c', 'channel:channel-wechat-1:d'])
  })

  it('skips disabled subscriptions on both paths', () => {
    const { ctx, emit } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('channel-wechat-1', [userMessage('a', 'a')])
    const bridge = makeBridge(ctx, sessions)
    const id = subscribe('channel-wechat-1')
    store.upsertSource({ ...store.getSource(id)!, enabled: false })

    emit('channel-wechat-1', userMessage('m1', '停用期间'))
    bridge.reconcile()
    expect(store.listMessages()).toHaveLength(0)
    expect(store.getSource(id)!.cursor).toBeUndefined() // never baselined either
  })

  it('caps each pass at the reconcile window and continues next pass', () => {
    const { ctx } = fakeCtx()
    const sessions = new FakeSessions()
    sessions.add('channel-wechat-1')
    const bridge = makeBridge(ctx, sessions)
    subscribe('channel-wechat-1')
    bridge.reconcile() // baseline at 0

    for (let i = 0; i < RECONCILE_WINDOW_EVENTS + 7; i++) {
      sessions.append('channel-wechat-1', userMessage(`m${i}`, `消息 ${i}`))
    }
    bridge.reconcile()
    expect(channelEvents()).toHaveLength(RECONCILE_WINDOW_EVENTS)
    expect(parseChannelCursor(store.getSource('src_channel_wechat_1')!.cursor).lastSeq).toBe(RECONCILE_WINDOW_EVENTS)

    bridge.reconcile()
    expect(channelEvents()).toHaveLength(RECONCILE_WINDOW_EVENTS + 7)
  })

  it('tolerates a session that is not live', () => {
    const { ctx } = fakeCtx()
    const sessions = new FakeSessions()
    const bridge = makeBridge(ctx, sessions)
    subscribe('channel-wechat-gone') // no session ever created
    expect(() => bridge.reconcile()).not.toThrow()
    expect(store.listMessages()).toHaveLength(0)
  })
})

describe('start / stop', () => {
  it('runs the sweep periodically and stops cleanly', () => {
    vi.useFakeTimers()
    try {
      const { ctx } = fakeCtx()
      const sessions = new FakeSessions()
      sessions.add('channel-wechat-1')
      const ledger = new MessageService(store, { now: () => now })
      const bridge = new ChannelBridge(ctx, store, ledger, {
        now: () => now,
        sessions,
        reconcileIntervalMs: 60_000,
      })
      subscribe('channel-wechat-1')

      bridge.start()
      vi.advanceTimersByTime(60_000) // first sweep records the baseline
      sessions.append('channel-wechat-1', userMessage('m1', '定时到达'))
      vi.advanceTimersByTime(60_000)
      expect(channelEvents()).toHaveLength(1)

      bridge.stop()
      sessions.append('channel-wechat-1', userMessage('m2', '停止后到达'))
      vi.advanceTimersByTime(180_000)
      expect(channelEvents()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pure helpers', () => {
  it('extractInboundMessages keeps only inbound user text', () => {
    const extracted = extractInboundMessages([
      otherEvent('turn/start'),
      userMessage('m1', '你好'),
      userMessage('m2', '合成', 'assistant'),
      userMessage('', '无 id'),
    ])
    expect(extracted).toEqual([{ messageId: 'm1', preview: '你好' }])
  })

  it('parseChannelConfig rejects unusable configs', () => {
    expect(parseChannelConfig(null)).toBeUndefined()
    expect(parseChannelConfig({ sessionId: 's' })).toBeUndefined() // channel missing
    expect(parseChannelConfig({ channel: 'lark', sessionId: ' ' })).toBeUndefined()
    expect(parseChannelConfig({ channel: 'telegram', sessionId: 's' })).toBeUndefined()
    const parsed = parseChannelConfig({ channel: 'lark', sessionId: 'lark-1', condition: ' 关注点 ', extra: 1 })
    expect(parsed).toEqual({ channel: 'lark', sessionId: 'lark-1', condition: '关注点' })
  })

  it('parseChannelCursor tolerates foreign shapes', () => {
    expect(parseChannelCursor(undefined)).toEqual({})
    expect(parseChannelCursor('junk')).toEqual({})
    expect(parseChannelCursor({ lastSeq: 3.7 })).toEqual({ lastSeq: 3 })
    expect(parseChannelCursor({ lastSeq: -1 })).toEqual({})
  })
})
