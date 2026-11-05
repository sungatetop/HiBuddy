/**
 * Startup reconciliation (resident-design.md §8 recovery semantics).
 *
 * After the state directory is locked and the database opened, align durable
 * state with reality before the orchestrator starts:
 *   1. source read positions live in SQLite already (restore = no-op here);
 *   2. tickets left `working` are resumed via hook when a worker orchestrator
 *      is available (B4), otherwise marked `interrupted` for user confirmation;
 *   3. `awaiting_approval` tickets keep waiting; their unread notifications get
 *      delivery flags cleared so the user is re-reached;
 *   4. panel state is read from SQLite wholesale (no action needed).
 *
 * Missed one-shot tickets (nextRunAt in the past) are NOT rewritten here: the
 * scheduler (B3) fires them once on its first pass with a "late trigger" note,
 * while periodic tickets simply skip missed rounds by moving to the next due
 * time — both need the timer loop that B2 does not yet own.
 */

import type { Ticket } from './domain.ts'
import { isTerminal } from './domain.ts'
import type { Store } from './store.ts'

/** Optional integration points the orchestrator layers provide once built. */
export interface ReconcileHooks {
  /**
   * Resume a worker session for a ticket that was `working` at shutdown
   * (B4 supplies this; the default marks the ticket `interrupted` instead).
   * Return true only when the session was actually resumed.
   */
  resumeWorker?(ticket: Ticket): Promise<boolean> | boolean
}

/** What the reconciliation pass did; logged at startup and asserted in tests. */
export interface ReconcileSummary {
  /** `working` tickets resumed through the hook. */
  resumed: number
  /** `working` tickets marked `interrupted` (no resume hook / resume refused). */
  interrupted: number
  /** `awaiting_approval` tickets found (kept as-is). */
  awaitingApproval: number
  /** Unread awaiting-approval notifications re-armed for delivery. */
  reNotified: number
  /** One-shot tickets whose due time already passed (scheduler fires once, B3). */
  missedOneShots: number
}

/**
 * Run the four reconciliation steps against an open store.
 * @param now - startup instant (ISO), injected for determinism in tests.
 */
export async function reconcile(
  store: Store,
  now: string,
  hooks: ReconcileHooks = {},
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    resumed: 0,
    interrupted: 0,
    awaitingApproval: 0,
    reNotified: 0,
    missedOneShots: 0,
  }

  // Step 1: source read positions persist in SQLite — nothing to replay.

  for (const ticket of store.listTickets()) {
    if (isTerminal(ticket.state)) continue

    if (ticket.state === 'working') {
      // The previous round was physically interrupted by the shutdown: close
      // its run up front — a resumed round (resumeWorker) starts a fresh run.
      store.transaction(() => {
        const runs = store.listRuns(ticket.id)
        const openRun = [...runs].reverse().find((run) => run.finishedAt == null)
        if (openRun && openRun.id !== undefined) {
          store.finishRun(openRun.id, now, 'interrupted', 'host restarted while working')
        }
      })
      let resumed = false
      try {
        resumed = (await hooks.resumeWorker?.(ticket)) === true
      } catch {
        // a failing resume must not abort boot; fall through to interrupted
      }
      if (resumed) {
        summary.resumed += 1
      } else {
        store.upsertTicket({ ...ticket, interrupted: true })
        summary.interrupted += 1
      }
      continue
    }

    if (ticket.state === 'awaiting_approval') {
      summary.awaitingApproval += 1
      continue
    }

    if (ticket.state === 'pending' && !ticket.period && ticket.nextRunAt && ticket.nextRunAt < now) {
      summary.missedOneShots += 1
    }
  }

  // Step 3: re-arm delivery of unread awaiting-approval notifications.
  summary.reNotified = store.redeliverNotifications((n) => n.type === 'awaiting_approval')

  // Step 4: panel state is read from SQLite wholesale — nothing to do.
  return summary
}
