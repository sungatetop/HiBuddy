/**
 * Conversation ledger service (ADR-011 D2/D11; replaces the B6 notification
 * surface). Every user-facing record is a row in `messages` with a direction:
 *
 * - **in**  — user text, event envelopes (monitor hits, worker receipts,
 *   approval events). Written by the host, consumed by a butler turn.
 * - **out** — the butler's `send_message_to_user` output, plus approval cards
 *   the host writes on `approval/asked`.
 *
 * Invariants kept from the notification surface:
 * 1. Persist before delivery (FR-10 rule 3) — `delivered=false` lands first.
 * 2. Idempotency — a repeated key is dropped by the store.
 * 3. Do-not-disturb silences PUSH only; the row is still recorded and the
 *    butler turn still runs (design §7 「待批不挂起」).
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Message, MessageDirection, MessageKind, MessageRefs } from './domain.ts'
import type { Store } from './store.ts'

/** Settings key holding the do-not-disturb window (`{start,end}`, `HH:MM`). */
export const QUIET_HOURS_KEY = 'quietHours'

/** Settings key holding ticket ids exempt from the do-not-disturb window. */
export const QUIET_EXCEPTIONS_KEY = 'quietExceptions'

/** A `HH:MM` local-time window; `end` earlier than `start` crosses midnight. */
export interface QuietWindow {
  start: string
  end: string
}

/** What a producer wants recorded. */
export interface MessageInput {
  direction: MessageDirection
  kind: MessageKind
  text: string
  title?: string
  refs?: MessageRefs
  /** Producer-owned dedup identity; defaults to the content fingerprint key. */
  idempotencyKey?: string
}

/** Outcome of one append call. */
export interface MessageOutcome {
  /** False when the idempotency key already existed (nothing recorded). */
  recorded: boolean
  /** True when the row was recorded AND pushed now (outbound only). */
  delivered: boolean
  /** The recorded row (absent for duplicates). */
  message?: Message
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Minutes since local midnight for a `HH:MM` clock string. */
function minutesOfDay(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number) as [number, number]
  return hours * 60 + minutes
}

/**
 * Reads the do-not-disturb window from settings, tolerating absent, null, or
 * malformed values (a bad window must never break delivery).
 */
export function parseQuietWindow(value: unknown): QuietWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { start, end } = value as Partial<QuietWindow>
  if (typeof start !== 'string' || typeof end !== 'string') return undefined
  if (!CLOCK_PATTERN.test(start) || !CLOCK_PATTERN.test(end)) return undefined
  return { start, end }
}

/**
 * True when `now` falls inside the window. Windows are half-open `[start,end)`
 * in local time; a window whose start equals its end is empty (never quiet).
 */
export function inQuietWindow(now: Date, window: QuietWindow): boolean {
  const start = minutesOfDay(window.start)
  const end = minutesOfDay(window.end)
  if (start === end) return false
  const at = now.getHours() * 60 + now.getMinutes()
  return start < end ? at >= start && at < end : at >= start || at < end
}

/** Default idempotency key: direction + kind + owner + content fingerprint. */
export function contentKey(
  direction: MessageDirection,
  kind: MessageKind,
  refs: MessageRefs | undefined,
  title: string | undefined,
  text: string,
): string {
  const fingerprint = createHash('sha256')
    .update(`${title ?? ''}\n${text}`)
    .digest('hex')
    .slice(0, 16)
  const owner = refs?.ticketId ?? refs?.sourceId ?? refs?.sessionId ?? 'global'
  return `${direction}:${kind}:${owner}:${fingerprint}`
}

export interface MessageServiceOptions {
  /** Injectable clock for determinism in tests. */
  now?: () => Date
}

/**
 * The single write path for the conversation ledger. Owns no state beyond the
 * store, so producers may share one instance (the host wires one).
 */
export class MessageService {
  private readonly store: Store
  private readonly now: () => Date

  constructor(store: Store, options: MessageServiceOptions = {}) {
    this.store = store
    this.now = options.now ?? (() => new Date())
  }

  /** Configured do-not-disturb window, when valid. */
  quietWindow(): QuietWindow | undefined {
    return parseQuietWindow(this.store.getSetting<unknown>(QUIET_HOURS_KEY))
  }

  /** True when pushes are silenced right now. */
  isQuiet(now: Date = this.now()): boolean {
    const window = this.quietWindow()
    return window === undefined ? false : inQuietWindow(now, window)
  }

  /** Ticket ids exempt from the window (design §9「按 ticket 例外」). */
  private exceptions(): ReadonlySet<string> {
    const raw = this.store.getSetting<unknown>(QUIET_EXCEPTIONS_KEY)
    return new Set(Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [])
  }

  /**
   * True when this outbound message must wait out the window. Inside the
   * window EVERYTHING is silenced except messages owned by an exception
   * ticket (design §9「窗内仅落库，按 ticket 例外」).
   */
  private silenced(refs: MessageRefs | undefined, now: Date): boolean {
    if (!this.isQuiet(now)) return false
    const ticketId = refs?.ticketId ?? null
    return !(ticketId !== null && this.exceptions().has(ticketId))
  }

  /**
   * Records a message, then pushes it when it is outbound and not silenced.
   * Inbound rows are already in the user's view (they came from it) and are
   * never pushed. Never throws: a broken ledger write must not take down the
   * calling pipeline.
   */
  post(input: MessageInput): MessageOutcome {
    const now = this.now()
    const message: Message = {
      id: `msg_${randomUUID()}`,
      direction: input.direction,
      kind: input.kind,
      ...(input.title !== undefined ? { title: input.title } : {}),
      text: input.text,
      ...(input.refs !== undefined ? { refs: input.refs } : {}),
      idempotencyKey:
        input.idempotencyKey ??
        contentKey(input.direction, input.kind, input.refs, input.title, input.text),
      read: false,
      delivered: input.direction === 'in',
      createdAt: now.toISOString(),
    }

    let recorded: boolean
    try {
      recorded = this.store.addMessage(message)
    } catch (error) {
      console.error('[hibuddy-resident] message persist failed:', error)
      return { recorded: false, delivered: false }
    }
    if (!recorded) return { recorded: false, delivered: false }

    if (input.direction === 'in') return { recorded: true, delivered: true, message }

    const quiet = this.silenced(message.refs, now)
    if (!quiet) {
      this.store.markMessageDelivered(message.id)
      message.delivered = true
    }
    return { recorded: true, delivered: !quiet, message }
  }

  /** Convenience: butler output. */
  postOutbound(input: Omit<MessageInput, 'direction'>): MessageOutcome {
    return this.post({ ...input, direction: 'out' })
  }

  /** Convenience: user text, event envelope, worker receipt, approval event. */
  postInbound(input: Omit<MessageInput, 'direction'>): MessageOutcome {
    return this.post({ ...input, direction: 'in' })
  }

  /**
   * Re-reaches recorded-but-undelivered unread messages: the startup pass and
   * the window-exit pass after settings change. Returns the delivered count.
   */
  deliverPending(): number {
    const now = this.now()
    const quiet = this.isQuiet(now)
    const exceptions = this.exceptions()
    let delivered = 0
    for (const message of this.store.listMessages({ undeliveredOnly: true, limit: 1000 })) {
      if (message.read) continue
      if (message.direction === 'in') continue
      const ticketId = message.refs?.ticketId ?? null
      if (quiet && !(ticketId !== null && exceptions.has(ticketId))) continue
      this.store.markMessageDelivered(message.id)
      delivered += 1
    }
    return delivered
  }

  /** Unread outbound count for the chat badge. */
  unreadCount(): number {
    return this.store.countUnreadMessages()
  }

  /** Newest-first list (inbox) or oldest-first replay (chat). */
  list(
    options: { direction?: MessageDirection; unreadOnly?: boolean; oldestFirst?: boolean; limit?: number } = {},
  ): Message[] {
    return this.store.listMessages(options)
  }

  /** Inbound rows a butler turn has not consumed yet, oldest first. */
  pendingInbound(limit = 100): Message[] {
    return this.store.listPendingInbound(limit)
  }

  /** Advances the queue cursor after a turn consumed the rows. */
  consume(ids: readonly string[]): number {
    return this.store.markInboundConsumed(ids, this.now().toISOString())
  }

  markRead(id: string): void {
    this.store.markMessageRead(id)
  }

  markAllRead(): number {
    const unread = this.unreadCount()
    this.store.markAllMessagesRead()
    return unread
  }
}
