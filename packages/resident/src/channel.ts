/**
 * Channel bridge (channel-message-source-design.md v3, push architecture) —
 * IM channel messages flow INTO the butler conversation, not through the
 * trigger/filter pipeline.
 *
 * Architecture (user-corrected): the four channel plugins (dsh-lark-channel /
 * dsh-dingtalk / dsh-channel-wechat / dsh-onebot-qq) each drive their own
 * per-chat agent sessions; every platform message a user sends lands in that
 * session's log as a `user/message` event with `source.kind === 'user'`. The
 * bridge:
 *
 * 1. **Push (timeliness)** — subscribes to `session/event`; when a message
 *    arrives on a subscribed channel session, it is extracted and written to
 *    the conversation ledger (`postInbound`). The ledger's `onInbound`
 *    wakes the butler pump, so the message enters the NEXT butler turn
 *    automatically — the butler is a full AgentLoop and judges each message
 *    itself (relay to the user / delegate via create_session / ignore).
 * 2. **Reconcile (correctness, 60s low-frequency sweep)** — the safety net
 *    for events missed while the bridge was down (restart gaps, listener
 *    loss): reads the subscribed session's log window from the persisted
 *    cursor and delivers the same way. Overlap with the push path is
 *    inherently safe: the ledger dedupes on the idempotency key
 *    `channel:<sessionId>:<messageId>`, so a message is never delivered
 *    twice no matter how many paths saw it. The cursor is an efficiency
 *    optimization only, never a correctness dependency (ADR-012 layering
 *    stands: events own timeliness, the sweep owns correctness).
 *
 * First-scan baseline: a brand-new subscription records `lastSeq = seq`
 * without firing — subscribing never replays the chat's history.
 *
 * Injection surface: channel text is external data (`untrusted: true`,
 * design §6) — the butler's envelope frames it as data, never instructions.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SourceInstance } from './domain.ts'
import type { MessageService } from './messages.ts'
import type { Store } from './store.ts'

/** Reconcile cadence — a low-frequency safety net, not the delivery path. */
export const RECONCILE_INTERVAL_MS = 60_000

/** Max log events read per reconcile pass per subscription (downtime cap). */
export const RECONCILE_WINDOW_EVENTS = 500

/** Preview length cap for the ledger envelope text. */
export const PREVIEW_MAX_CHARS = 500

/** Channels the bridge recognizes; session-id prefixes follow each plugin. */
export const CHANNEL_IDS = ['wechat', 'lark', 'onebot', 'dingtalk'] as const
export type ChannelId = (typeof CHANNEL_IDS)[number]

/**
 * Session-id prefix per channel (used by the butler's discovery when adding a
 * subscription without an explicit session id). dingtalk sessions carry a
 * bare randomUUID — no prefix; discovery reads the plugin's bindings stores
 * instead (discoverDingtalkSessions).
 */
export const CHANNEL_SESSION_PREFIXES: Record<ChannelId, string | undefined> = {
  wechat: 'channel-wechat-',
  lark: 'lark-',
  onebot: 'onebot-',
  dingtalk: undefined,
}

/** The dingtalk plugin's own state dir (its paths.js: env override or ~/.dsh-dingtalk). */
export function dingtalkStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_DINGTALK_STATE_DIR ?? join(homedir(), '.dsh-dingtalk')
}

/** dingtalk session ids are bare randomUUIDs (bridge.js: sessionId(randomUUID())). */
const DINGTALK_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Discovers dingtalk agent sessions from the plugin's persisted bindings
 * stores (dsh-dingtalk 0.10.2): each conversation→session binding lives as a
 * plain `{conversationId: sessionId}` JSON map at `bindings.json` under the
 * default robot's state dir, each extra robot's `accounts/<id>/`, and each
 * digital employee's `digital-employees/<uuid>/`. Values are bare UUIDs —
 * format-checked so foreign keys never leak in; duplicates dedupe. Unreadable
 * or missing files are skipped (a robot without credentials has no bindings).
 */
export function discoverDingtalkSessions(stateDir: string = dingtalkStateDir()): string[] {
  const found = new Set<string>()
  const files: string[] = [join(stateDir, 'bindings.json')]
  for (const sub of ['accounts', 'digital-employees']) {
    try {
      for (const entry of readdirSync(join(stateDir, sub), { withFileTypes: true })) {
        if (entry.isDirectory()) files.push(join(stateDir, sub, entry.name, 'bindings.json'))
      }
    } catch {
      // Subtree absent — nothing to add.
    }
  }
  for (const file of files) {
    let map: unknown
    try {
      map = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue // unreadable — skip
    }
    if (typeof map !== 'object' || map === null) continue
    for (const value of Object.values(map as Record<string, unknown>)) {
      if (typeof value === 'string' && DINGTALK_SESSION_ID_RE.test(value)) found.add(value)
    }
  }
  return [...found]
}

/** Live dsh session the bridge reads from (host `sessions` service face). */
export interface ChannelSessionLike {
  /** Current event count (next write offset). */
  readonly seq: number
  /** Events in [firstSeq, seq). */
  snapshotEvents(firstSeq: number, toSeq: number): readonly ChannelSessionEvent[]
}

/** Structural slice of a session event (dsh `user/message` and friends). */
export interface ChannelSessionEvent {
  readonly type: string
  readonly data?: unknown
}

/** Reader abstraction; the host injects the live session store. */
export interface ChannelSessionReader {
  get(sessionId: string): ChannelSessionLike | undefined
}

/** One extracted inbound message (the ledger envelope basis). */
export interface ChannelInboundMessage {
  /** The dsh message id — stable identity across every representation. */
  messageId: string
  /** Text blocks joined (truncated to PREVIEW_MAX_CHARS). */
  preview: string
}

/**
 * Extracts inbound user messages from session events. Only `user/message`
 * events with `source.kind === 'user'` count (the channel plugins post
 * platform messages through `createUserMessage`); synthetic injections
 * (file notices, skill content, …) carry other source kinds and are never
 * delivered — the butler must not see the channel agent's own internals as
 * if the human said them.
 */
export function extractInboundMessages(events: readonly ChannelSessionEvent[]): ChannelInboundMessage[] {
  const messages: ChannelInboundMessage[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const message = event.data as { id?: unknown; content?: unknown; source?: { kind?: unknown } } | undefined
    if (message === null || typeof message !== 'object') continue
    if (message.source?.kind !== 'user') continue
    if (typeof message.id !== 'string' || message.id === '') continue
    const preview = textOf(message.content)
    messages.push({ messageId: message.id, preview })
  }
  return messages
}

/** Joins the text blocks of a message content array, truncated. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const joined = content
    .map((block) => (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
      ? String((block as { text?: unknown }).text ?? '')
      : ''))
    .join('')
  return joined.length > PREVIEW_MAX_CHARS ? `${joined.slice(0, PREVIEW_MAX_CHARS)}…` : joined
}

/** Channel subscription configuration (stored as `source_instances.config`). */
export interface ChannelConfig {
  /** Display name (tool output, envelope title). */
  name?: string
  /** Which channel the subscription belongs to. */
  channel: ChannelId
  /** The channel plugin's agent session id (stable per chat). */
  sessionId: string
  /** Natural-language "when to care" hint, shown to the butler in the envelope. */
  condition?: string
}

/** Channel read position (stored as `source_instances.cursor`). */
export interface ChannelCursor {
  /** Log offset already covered; absent for a brand-new subscription (baseline). */
  lastSeq?: number
  lastScanAt?: string
}

/** Validate a raw instance config; undefined when unusable. */
export function parseChannelConfig(config: unknown): ChannelConfig | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const raw = config as Record<string, unknown>
  if (typeof raw.sessionId !== 'string' || raw.sessionId.trim() === '') return undefined
  if (typeof raw.channel !== 'string' || !CHANNEL_IDS.includes(raw.channel as ChannelId)) return undefined
  const parsed: ChannelConfig = { channel: raw.channel as ChannelId, sessionId: raw.sessionId }
  if (typeof raw.name === 'string' && raw.name.trim() !== '') parsed.name = raw.name.trim()
  if (typeof raw.condition === 'string' && raw.condition.trim() !== '') parsed.condition = raw.condition.trim()
  return parsed
}

/** Parse a stored cursor; tolerant of foreign/legacy shapes. */
export function parseChannelCursor(cursor: unknown): ChannelCursor {
  if (typeof cursor !== 'object' || cursor === null) return {}
  const raw = cursor as Record<string, unknown>
  const parsed: ChannelCursor = {}
  if (typeof raw.lastSeq === 'number' && Number.isFinite(raw.lastSeq) && raw.lastSeq >= 0) {
    parsed.lastSeq = Math.floor(raw.lastSeq)
  }
  if (typeof raw.lastScanAt === 'string') parsed.lastScanAt = raw.lastScanAt
  return parsed
}

/** One channel subscription as the butler tool face returns it. */
export interface ChannelSourceInfo {
  id: string
  enabled: boolean
  channel: ChannelId
  sessionId: string
  name?: string
  condition?: string
}

export interface ChannelBridgeOptions {
  /** Injectable clock for determinism in tests. */
  now?: () => Date
  /** Reconcile interval override (tests shrink it). */
  reconcileIntervalMs?: number
  /** Live session reader override (tests); default resolves the host service lazily. */
  sessions?: ChannelSessionReader
}

/**
 * Pushes channel messages into the butler conversation. Reads subscriptions
 * from `source_instances` (kind `channel`, managed by the butler's
 * `manage_channel_sources` tool) on every use, so tool mutations take effect
 * immediately without cache invalidation.
 */
export class ChannelBridge {
  private readonly ctx: Context
  private readonly store: Store
  private readonly ledger: MessageService
  private readonly now: () => Date
  private readonly reconcileIntervalMs: number
  private readonly sessionsOverride: ChannelSessionReader | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly stopListening: (() => void) | undefined

  constructor(ctx: Context, store: Store, ledger: MessageService, options: ChannelBridgeOptions = {}) {
    this.ctx = ctx
    this.store = store
    this.ledger = ledger
    this.now = options.now ?? (() => new Date())
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS
    this.sessionsOverride = options.sessions
    // Push path: any session event on a subscribed channel session is
    // delivered immediately. Never throws into the host's event dispatch.
    this.stopListening = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      try {
        this.handleSessionEvent(String(session.id), event)
      } catch (error) {
        console.error('[hibuddy-resident] channel push failed:', error)
      }
    })
  }

  /** Starts the reconcile sweep; idempotent. */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      try {
        this.reconcile()
      } catch (error) {
        console.error('[hibuddy-resident] channel reconcile failed:', error)
      }
    }, this.reconcileIntervalMs)
    this.timer.unref?.()
  }

  /** Stops the sweep and the event listener. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.stopListening?.()
  }

  /** Live sessions: the override (tests) or the host `sessions` service. */
  private sessionReader(): ChannelSessionReader | undefined {
    if (this.sessionsOverride !== undefined) return this.sessionsOverride
    return (this.ctx.get('sessions') as ChannelSessionReader | undefined) ?? undefined
  }

  /** Subscribed, enabled instances, freshest from the store. */
  private subscriptions(): Array<{ instance: SourceInstance; config: ChannelConfig }> {
    const out: Array<{ instance: SourceInstance; config: ChannelConfig }> = []
    for (const instance of this.store.listSources()) {
      if (instance.kind !== 'channel' || !instance.enabled) continue
      const config = parseChannelConfig(instance.config)
      if (config !== undefined) out.push({ instance, config })
    }
    return out
  }

  /** Push path: one session event on one session. */
  private handleSessionEvent(sessionId: string, event: SessionEvent): void {
    if (event.type !== 'user/message') return
    const sub = this.subscriptions().find((entry) => entry.config.sessionId === sessionId)
    if (sub === undefined) return
    this.deliver(sub.instance, sub.config, [event])
  }

  /** Safety net: catch each subscribed session's log up from its cursor. */
  reconcile(): void {
    const sessions = this.sessionReader()
    if (sessions === undefined) return
    const nowIso = this.now().toISOString()
    for (const { instance, config } of this.subscriptions()) {
      const session = sessions.get(config.sessionId)
      if (session === undefined) continue // not live — the push path or a later sweep catches it
      const cursor = parseChannelCursor(instance.cursor)
      if (cursor.lastSeq === undefined) {
        // Baseline: record the current end without firing (no history replay).
        this.persistCursor(instance, { lastSeq: session.seq, lastScanAt: nowIso })
        continue
      }
      const from = cursor.lastSeq
      if (session.seq <= from) continue // nothing new
      const to = Math.min(session.seq, from + RECONCILE_WINDOW_EVENTS)
      this.deliver(instance, config, session.snapshotEvents(from, to))
      this.persistCursor(instance, { lastSeq: to, lastScanAt: nowIso })
    }
  }

  /**
   * Extracts and records the inbound rows; the ledger's `onInbound` wakes the
   * butler pump, so a channel message enters the next butler turn. Idempotent:
   * the key `channel:<sessionId>:<messageId>` makes every path (push,
   * reconcile, restart overlap) converge to one row.
   */
  private deliver(instance: SourceInstance, config: ChannelConfig, events: readonly ChannelSessionEvent[]): void {
    for (const message of extractInboundMessages(events)) {
      const text =
        message.preview === '' ? '（该消息不含文本内容）' : message.preview
      this.ledger.postInbound({
        kind: 'event',
        refs: { sourceId: instance.id, sessionId: config.sessionId },
        idempotencyKey: `channel:${config.sessionId}:${message.messageId}`,
        title: `${config.name ?? config.channel} 渠道新消息`,
        text: config.condition === undefined ? text : `${text}\n（订阅关注点：${config.condition}）`,
        data: { code: 'channel_message', sourceId: instance.id, sessionId: config.sessionId, untrusted: true },
      })
    }
  }

  /** Persists the cursor (efficiency only — the ledger dedup is the guard). */
  private persistCursor(instance: SourceInstance, cursor: ChannelCursor): void {
    this.store.upsertSource({ ...instance, cursor })
  }
}
