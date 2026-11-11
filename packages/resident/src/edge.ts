/**
 * L1 edge events (perception B12′ §6, D4) — state transitions the butler
 * should hear about, delivered as inbound event envelopes with idempotency
 * keys and do-not-disturb suppression:
 *
 * - `stalled` / `resumed`: a `working` ticket whose worker session produced no
 *   session event for `stallMinutes` (default 10) is stalled; the first event
 *   afterwards resumes it. Keyed `stall|resume:<ticketId>:<runId>` (once per
 *   run). In-memory only — a host restart resets the clock (acceptable, the
 *   next scan re-arms from the ticket's updatedAt).
 * - `question_unanswered`: an outbound `question` row stays unread past
 *   `reminderMinutes` (default 30) with no later user input. Keyed
 *   `question:<messageId>:reminder` (once per message).
 *
 * `monitor_triggered` lives in the filter (it fires exactly when a monitor hit
 * becomes a ticket), not here — this detector only polls durable state.
 *
 * Every scan is guarded by the `perceptionEvents` switch and the do-not-disturb
 * window: inside the window (or with the switch off) NO edge event is produced,
 * so a quiet night does not wake the butler.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Store } from './store.ts'
import type { MessageService } from './messages.ts'

/** Default stall threshold (design §6), minutes. */
export const DEFAULT_STALL_MINUTES = 10

/** Default unanswered-question reminder delay (design §6), minutes. */
export const DEFAULT_REMINDER_MINUTES = 30

/** Scan cadence (design §6: 30s). */
export const SCAN_INTERVAL_MS = 30_000

/** Options; every reader resolves from settings so the panel can tune them. */
export interface EdgeOptions {
  /** Injectable clock for determinism in tests. */
  now?: () => Date
  /** Perception-events master switch (settings `perceptionEvents`, default on). */
  enabled?: () => boolean
  /** Stall threshold in minutes (settings `stallMinutes`). */
  stallMinutes?: () => number
  /** Reminder delay in minutes (settings `reminderMinutes`). */
  reminderMinutes?: () => number
  /** Scan interval (tests shrink it). */
  scanIntervalMs?: number
}

/** One worker session's activity bookkeeping. */
interface Activity {
  /** Monotonic-ish event clock (ms); a session event refreshes it. */
  lastEventAt: number
}

/**
 * Polls durable state for L1 edge events. Subscribe to `session/event` to keep
 * per-session activity, then `scan()` (or `start()`) decides stalled/resumed
 * and unanswered-question reminders. Never throws: a broken scan degrades to
 * no events.
 */
export class EdgeDetector {
  private readonly store: Store
  private readonly notifier: MessageService
  private readonly now: () => Date
  private readonly enabled: () => boolean
  private readonly stallMs: () => number
  private readonly reminderMs: () => number
  private readonly scanIntervalMs: number
  private readonly activity = new Map<string, Activity>()
  /** Sessions flagged stalled in the current run (waiting for the first event). */
  private readonly stalledFlags = new Map<string, boolean>()
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly stopListening: () => void

  constructor(ctx: Context, store: Store, notifier: MessageService, options: EdgeOptions = {}) {
    this.store = store
    this.notifier = notifier
    this.now = options.now ?? (() => new Date())
    this.enabled = options.enabled ?? (() => this.store.getSetting<boolean>('perceptionEvents') ?? true)
    this.stallMs = options.stallMinutes ?? (() => this.stallMinutes())
    this.reminderMs = options.reminderMinutes ?? (() => this.reminderMinutes())
    this.scanIntervalMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS

    // Any session event advances that session's clock; scans only consult the
    // sessions of `working` tickets, so unrelated sessions are harmless.
    this.stopListening = ctx.on('session/event', (session: Session) => {
      this.activity.set(String(session.id), { lastEventAt: this.now().getTime() })
    })
  }

  private stallMinutes(): number {
    const configured = this.store.getSetting<number>('stallMinutes')
    return typeof configured === 'number' && configured >= 1 ? Math.floor(configured) : DEFAULT_STALL_MINUTES
  }

  private reminderMinutes(): number {
    const configured = this.store.getSetting<number>('reminderMinutes')
    return typeof configured === 'number' && configured >= 1 ? Math.floor(configured) : DEFAULT_REMINDER_MINUTES
  }

  /** One scan pass: stalls/resumes then unanswered questions. */
  scan(): void {
    if (!this.enabled()) return
    const now = this.now()
    if (this.notifier.isQuiet(now)) return // do-not-disturb: no edge events
    this.scanStalls(now)
    this.scanQuestions(now)
  }

  /** Working tickets whose session fell silent for `stallMinutes` → stalled; the first event after → resumed. */
  private scanStalls(now: Date): void {
    const stallThreshold = this.stallMs() * 60_000
    for (const ticket of this.store.listTickets()) {
      if (ticket.state !== 'working' || ticket.sessionId === undefined || ticket.sessionId === null) continue
      const sessionId = ticket.sessionId
      // Fall back to the ticket's updatedAt (the dispatch moment) so a session
      // that produced no events yet still has a stall clock.
      const lastEventAt = this.activity.get(sessionId)?.lastEventAt ?? Date.parse(ticket.updatedAt)
      const stale = now.getTime() - lastEventAt > stallThreshold
      const flagged = this.stalledFlags.get(sessionId) ?? false
      const runId = this.currentRunId(ticket.id)
      if (stale && !flagged) {
        this.stalledFlags.set(sessionId, true)
        this.notifier.postInbound({
          kind: 'event',
          refs: { ticketId: ticket.id, sessionId },
          idempotencyKey: `stall:${ticket.id}:${runId}`,
          title: '任务疑似停滞',
          text: `任务「${truncateGoal(ticket.goal)}」的 worker 会话已 ${this.stallMs()} 分钟没有任何进展事件，可能卡住了。请判断是否需要干预。`,
          data: { code: 'stalled' },
        })
      } else if (!stale && flagged) {
        this.stalledFlags.delete(sessionId)
        this.notifier.postInbound({
          kind: 'event',
          refs: { ticketId: ticket.id, sessionId },
          idempotencyKey: `resume:${ticket.id}:${runId}`,
          title: '任务已恢复',
          text: `任务「${truncateGoal(ticket.goal)}」的 worker 会话恢复活动。`,
          data: { code: 'resumed' },
        })
      }
    }
  }

  /** Unread `question` rows older than `reminderMinutes` with no later user input. */
  private scanQuestions(now: Date): void {
    const reminderThreshold = this.reminderMs() * 60_000
    const laterUserAt = new Map<string, number>()
    for (const message of this.store.listMessages({ direction: 'in', oldestFirst: true })) {
      laterUserAt.set(message.id, Date.parse(message.createdAt))
    }
    for (const message of this.store.listMessages({ direction: 'out' })) {
      if (message.kind !== 'question' || message.read) continue
      const askedAt = Date.parse(message.createdAt)
      if (now.getTime() - askedAt < reminderThreshold) continue
      // A user input after the question counts as an answer path — no reminder.
      if ([...laterUserAt.values()].some((at) => at > askedAt)) continue
      this.notifier.postInbound({
        kind: 'event',
        refs: message.refs,
        idempotencyKey: `question:${message.id}:reminder`,
        title: '提问尚未得到答复',
        text: `你 ${this.reminderMs()} 分钟前的提问仍未答复：${clip(message.text)}。是否继续等待，或重新说明？`,
        data: { code: 'question_unanswered' },
      })
    }
  }

  /** The round id of the ticket's open run (0 when unknown). */
  private currentRunId(ticketId: string): number {
    const runs = this.store.listRuns(ticketId)
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i]!.finishedAt === undefined || runs[i]!.finishedAt === null) return runs[i]!.id ?? 0
    }
    return 0
  }

  /** Starts the periodic scan; idempotent. */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => this.scan(), this.scanIntervalMs)
  }

  /** Stops the periodic scan. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.stopListening()
  }
}

/** Cuts a goal to a scannable length. */
function truncateGoal(goal: string, max = 60): string {
  return goal.length <= max ? goal : `${goal.slice(0, max)}…`
}

/** Cuts a body to a scannable length. */
function clip(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
