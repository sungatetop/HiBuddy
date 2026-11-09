/**
 * Notification surface (resident-design.md §9): persist first, reach later.
 *
 * Every user-facing record — worker results, observe-mode would-act verdicts,
 * system problems (degraded sources, dispatch failures), and the B7 approval
 * prompts — goes through this service so three rules hold in one place:
 *
 * 1. **Persist before delivery** (PRD FR-10 rule 3): the row lands in SQLite
 *    with `delivered=false`; only then is delivery attempted, so a crash or a
 *    restart never loses a notification.
 * 2. **Idempotency**: the key is ticketId + type + content fingerprint, or an
 *    explicit stable key when the producer owns the dedup identity (a degraded
 *    source, a monitor fingerprint). A repeated key is dropped by the store.
 * 3. **Do-not-disturb window**: inside the configured window a notification is
 *    recorded only (`delivered` stays false) and is re-reached later by
 *    {@link NotificationService.deliverPending} — at host start, or when the
 *    panel changes the window (B8). Per-ticket exceptions bypass the window.
 *    The window silences PUSH only: ticket state is never touched here, so an
 *    approval pending inside the window keeps waiting and stays approvable
 *    (design §7 「待批不挂起」).
 *
 * The first-batch channel is the resident panel itself (unread count + the
 * notification tab, B8) reading these rows; in-session cards and desktop
 * system notifications are P1 (design §9).
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Notification, NotificationType } from './domain.ts'
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
export interface NotifyInput {
  type: NotificationType
  title: string
  body: string
  /** Owning ticket, when the notification is about one. */
  ticketId?: string | null
  /** Producer-owned dedup identity; defaults to the content fingerprint key. */
  idempotencyKey?: string
}

/** Outcome of one notify call. */
export interface NotifyOutcome {
  /** False when the idempotency key already existed (nothing recorded). */
  recorded: boolean
  /** True when the row was recorded AND reached a channel now. */
  delivered: boolean
  /** The recorded row (absent for duplicates). */
  notification?: Notification
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Minutes since local midnight for a `HH:MM` clock string. */
function minutesOfDay(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number) as [number, number]
  return hours * 60 + minutes
}

/**
 * Reads the do-not-disturb window from settings, tolerating absent, null, or
 * malformed values (a bad window must never break notification delivery).
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

/** Default idempotency key: ticketId + type + content fingerprint (design §9). */
export function contentKey(
  type: NotificationType,
  ticketId: string | null | undefined,
  title: string,
  body: string,
): string {
  const fingerprint = createHash('sha256')
    .update(`${title}\n${body}`)
    .digest('hex')
    .slice(0, 16)
  return `${ticketId ?? 'global'}:${type}:${fingerprint}`
}

export interface NotificationServiceOptions {
  /** Injectable clock for determinism in tests. */
  now?: () => Date
}

/**
 * The single write path for notifications. Owns no state beyond the store, so
 * producers may share one instance (the host wires one) or let a default be
 * built for them.
 */
export class NotificationService {
  private readonly store: Store
  private readonly now: () => Date

  constructor(store: Store, options: NotificationServiceOptions = {}) {
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
   * True when this notification must wait out the window. Inside the window
   * EVERYTHING is silenced except notifications owned by an exception ticket
   * (design §9「窗内仅落库，按 ticket 例外」).
   */
  private silenced(ticketId: string | null | undefined, now: Date): boolean {
    if (!this.isQuiet(now)) return false
    return !(ticketId !== undefined && ticketId !== null && this.exceptions().has(ticketId))
  }

  /**
   * Records a notification, then reaches the user unless silenced. Never
   * throws: a broken notification must not take down the calling pipeline.
   */
  notify(input: NotifyInput): NotifyOutcome {
    const now = this.now()
    const notification: Notification = {
      id: `ntf_${randomUUID()}`,
      ticketId: input.ticketId ?? null,
      type: input.type,
      idempotencyKey:
        input.idempotencyKey ?? contentKey(input.type, input.ticketId, input.title, input.body),
      title: input.title,
      body: input.body,
      read: false,
      delivered: false,
      createdAt: now.toISOString(),
    }

    let recorded: boolean
    try {
      recorded = this.store.addNotification(notification)
    } catch (error) {
      console.error('[hibuddy-resident] notification persist failed:', error)
      return { recorded: false, delivered: false }
    }
    if (!recorded) return { recorded: false, delivered: false }

    const quiet = this.silenced(notification.ticketId, now)
    if (!quiet) {
      this.store.markNotificationDelivered(notification.id)
      notification.delivered = true
    }
    return { recorded: true, delivered: !quiet, notification }
  }

  /**
   * Re-reaches recorded-but-undelivered unread notifications: the startup pass
   * (design §8 step 3 re-arms awaiting-approval rows) and the window-exit pass
   * the panel triggers after editing settings. Returns the delivered count.
   */
  deliverPending(): number {
    const now = this.now()
    const quiet = this.isQuiet(now)
    const exceptions = this.exceptions()
    let delivered = 0
    for (const notification of this.store.listNotifications({ undeliveredOnly: true })) {
      if (notification.read) continue
      if (quiet && !(notification.ticketId != null && exceptions.has(notification.ticketId))) continue
      this.store.markNotificationDelivered(notification.id)
      delivered += 1
    }
    return delivered
  }

  /** Unread count for the panel badge (design §10 概览). */
  unreadCount(): number {
    return this.store.countUnreadNotifications()
  }

  /** Newest-first notification list for the panel tab. */
  list(options: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
    return this.store.listNotifications(options)
  }

  markRead(id: string): void {
    this.store.markNotificationRead(id)
  }

  markAllRead(): number {
    const unread = this.unreadCount()
    this.store.markAllNotificationsRead()
    return unread
  }
}
