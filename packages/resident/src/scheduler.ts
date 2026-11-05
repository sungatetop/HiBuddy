/**
 * Scheduler — timer-driven event source over the ticket schedule index
 * (resident-design.md §3.1, §5).
 *
 * Model note: in the personal scenario the Ticket itself is the schedule
 * carrier — `tickets.period` + `tickets.next_run_at` (indexed) are the only
 * timing state, matching §3.1 ("the Ticket persists, each due time produces
 * one run") and the B2 schema. The scheduler is therefore the event source
 * for scheduled tasks: every firing persists an immutable Trigger row (§3)
 * before the ticket moves. Polling sources with their own instance rows and
 * read positions (monitor) arrive with B5 on the SourceKind registry.
 *
 * Compensation (§5): a one-shot that came due while the host was down fires
 * exactly once, flagged `late` ("延迟触发"); a periodic ticket skips every
 * missed round and continues from the next future occurrence (anti-avalanche).
 * "Late" = the due time is older than `lateThresholdMs` — i.e. missed by a
 * restart or a stalled loop, not merely a tick of polling delay.
 *
 * Dispatch gate (§5 worker slots): the scheduler only fires when the
 * dispatcher (B4) reports a free slot. A refused ticket stays pending and is
 * retried on the next tick — no trigger row, no transition, no duplicated
 * history. The user-facing stop/approve surface never occupies a slot, so a
 * busy worker fleet cannot starve the user's own interactions.
 */

import { randomUUID } from 'node:crypto'
import type { Ticket } from './domain.ts'
import { transitionTicket } from './state-machine.ts'
import type { Store } from './store.ts'

/** Slot-gated consumer of fired rounds; the worker orchestrator (B4) implements it. */
export interface TicketDispatcher {
  /** True when at least one worker slot is free; consulted before any state change. */
  canDispatch(): boolean
  /**
   * Take the fired round. Called only after the scheduler persisted the
   * trigger and moved the ticket to `working`; the dispatcher owns the run
   * from here (start the run row, spawn/resume the worker session, and
   * transition to completed/failed/pending when done).
   */
  dispatch(ticket: Ticket, info: { late: boolean }): void
}

export interface SchedulerOptions {
  dispatcher?: TicketDispatcher
  /** Poll cadence in ms (default 1000 — an indexed query, cheap at this scale). */
  tickMs?: number
  /**
   * A due time older than this (default 30s) counts as "missed" — host was
   * down or the loop stalled. One-shots fire once flagged late; periodic
   * tickets drop the missed rounds (anti-avalanche, §5). Test-tunable.
   */
  lateThresholdMs?: number
  /** Injectable clock for determinism in tests. */
  now?: () => Date
}

/** What one scheduling pass did; logged at startup and asserted in tests. */
export interface TickStats {
  /** One-shot rounds fired (including late compensations). */
  firedOneShots: number
  /** Periodic rounds fired. */
  firedPeriodic: number
  /** One-shots fired because they came due while the host was down. */
  lateOneShots: number
  /** Periodic tickets whose missed rounds were skipped (next run moved forward). */
  skippedPeriodic: number
  /** Due tickets not fired because the dispatcher had no free slot. */
  deferredNoSlot: number
}

const EMPTY_STATS: TickStats = {
  firedOneShots: 0,
  firedPeriodic: 0,
  lateOneShots: 0,
  skippedPeriodic: 0,
  deferredNoSlot: 0,
}

/**
 * Next occurrence strictly after `nowMs` for a schedule anchored at `fromMs`.
 * Used both after an on-time fire (yields the following round) and when
 * skipping missed rounds; always strictly greater than `nowMs` so a fired
 * round can never be re-selected by the next tick at the same instant.
 */
export function nextOccurrence(fromMs: number, intervalMs: number, nowMs: number): string {
  const k = Math.max(1, Math.floor((nowMs - fromMs) / intervalMs) + 1)
  return new Date(fromMs + k * intervalMs).toISOString()
}

export class Scheduler {
  private readonly store: Store
  private readonly dispatcher?: TicketDispatcher
  private readonly tickMs: number
  private readonly lateThresholdMs: number
  private readonly now: () => Date
  private timer: ReturnType<typeof setInterval> | undefined
  private warnedNoDispatcher = false

  constructor(store: Store, options: SchedulerOptions = {}) {
    this.store = store
    this.dispatcher = options.dispatcher
    this.tickMs = options.tickMs ?? 1000
    this.lateThresholdMs = options.lateThresholdMs ?? 30_000
    this.now = options.now ?? (() => new Date())
  }

  /** Runs the first pass (startup compensation) and arms the poll timer. */
  start(): TickStats {
    const stats = this.tick()
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (error) {
        // a broken tick must never kill the host; the next tick retries
        console.error('[hibuddy-resident] scheduler tick failed:', error)
      }
    }, this.tickMs)
    // never keep the process alive just for the poll
    this.timer.unref?.()
    return stats
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** One scheduling pass over due tickets; public so tests drive it deterministically. */
  tick(): TickStats {
    const stats = { ...EMPTY_STATS }
    if (!this.dispatcher) {
      if (!this.warnedNoDispatcher) {
        console.warn(
          '[hibuddy-resident] no dispatcher configured; scheduled firing is inert until the worker orchestrator (B4) is wired',
        )
        this.warnedNoDispatcher = true
      }
      return stats
    }

    const nowIso = this.now().toISOString()
    for (const ticket of this.store.listTickets()) {
      if (ticket.state !== 'pending' || !ticket.nextRunAt) continue
      if (ticket.nextRunAt > nowIso) continue
      this.processDue(ticket, stats)
    }
    return stats
  }

  private processDue(ticket: Ticket, stats: TickStats): void {
    const nowMs = this.now().getTime()
    const dueMs = Date.parse(ticket.nextRunAt!)
    const late = nowMs - dueMs > this.lateThresholdMs
    const nextRunAt = ticket.period
      ? nextOccurrence(dueMs, ticket.period.intervalMs, nowMs)
      : null

    // Missed-round compensation for periodic tickets: the due time is stale
    // (host was down / loop stalled) → drop the missed rounds, only move the
    // schedule forward.
    if (ticket.period && late) {
      this.store.upsertTicket({ ...ticket, nextRunAt, updatedAt: this.now().toISOString() })
      stats.skippedPeriodic += 1
      return
    }

    // Slot gate: refuse without consuming anything; retried next tick.
    if (!this.dispatcher!.canDispatch()) {
      stats.deferredNoSlot += 1
      return
    }

    const firedAt = this.now().toISOString()
    this.store.transaction(() => {
      this.store.saveTrigger({
        id: `trg_${randomUUID()}`,
        sourceId: 'scheduler',
        at: firedAt,
        payload: { ticketId: ticket.id, late, ...(ticket.period ? { periodic: true } : {}) },
      })
      // pending → working is validated by the state machine; the (already
      // computed) next occurrence rides along in the same transaction so a
      // crash can never double-fire the round.
      transitionTicket(this.store, ticket, 'working', { nextRunAt })
    })

    if (ticket.period) {
      stats.firedPeriodic += 1
    } else {
      stats.firedOneShots += 1
      if (late) stats.lateOneShots += 1
    }
    this.dispatcher!.dispatch({ ...ticket, state: 'working', nextRunAt }, { late })
  }
}
