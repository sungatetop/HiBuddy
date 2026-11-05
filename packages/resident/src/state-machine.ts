/**
 * Ticket state machine (resident-design.md §3.1).
 *
 *   pending → working → awaiting_approval ⇄ working
 *                       ↘ completed
 *   working → failed → pending (user retry)
 *   any non-terminal → stopped (user stop, terminal)
 *
 * One deviation from the bare chart, required by §3.1 periodic semantics
 * ("the Ticket persists, each due time produces one run"): a periodic ticket
 * returns working → pending when a round completes, so the scheduler can pick
 * it up again. One-shot tickets may never take that edge.
 *
 * The orchestrator self-holds ticket state (never mirrors the worker session);
 * every transition is validated here and persisted atomically by the caller's
 * store. Terminal states clear the schedule index so the scheduler never
 * re-fires a finished ticket.
 */

import type { Ticket, TicketState } from './domain.ts'
import { isTerminal } from './domain.ts'
import type { Store } from './store.ts'

/** Allowed edges from each state; anything else is rejected. */
const ALLOWED: Readonly<Record<TicketState, readonly TicketState[]>> = {
  pending: ['working', 'stopped'],
  working: ['awaiting_approval', 'pending', 'completed', 'failed', 'stopped'],
  awaiting_approval: ['working', 'stopped'],
  failed: ['pending', 'stopped'],
  completed: [],
  stopped: [],
}

/** Raised on an illegal transition; message names the offending edge. */
export class TransitionError extends Error {
  constructor(from: TicketState, to: TicketState) {
    super(`illegal ticket transition ${from} → ${to}`)
    this.name = 'TransitionError'
  }
}

/**
 * Whether `from → to` is legal. Pure predicate so the panel (B8) can grey out
 * actions without attempting them.
 */
export function canTransition(from: TicketState, to: TicketState, period?: Ticket['period']): boolean {
  if (from === to) return false
  if (!ALLOWED[from].includes(to)) return false
  // working → pending is the "periodic round finished, reschedule me" edge;
  // one-shot tickets have no next round to schedule.
  if (from === 'working' && to === 'pending' && !period) return false
  return true
}

/**
 * Validate and persist a transition. Terminal targets clear `nextRunAt` (and
 * the `interrupted` flag) so the ticket leaves the scheduler index for good.
 * @returns the persisted ticket (callers keep using the returned object).
 */
export function transitionTicket(
  store: Store,
  ticket: Ticket,
  to: TicketState,
  patch: Partial<Ticket> = {},
): Ticket {
  if (!canTransition(ticket.state, to, ticket.period)) {
    throw new TransitionError(ticket.state, to)
  }
  const next: Ticket = {
    ...ticket,
    ...patch,
    state: to,
    updatedAt: new Date().toISOString(),
  }
  if (isTerminal(to)) {
    next.nextRunAt = null
    next.interrupted = false
  }
  if (to === 'pending') {
    // a retry (failed → pending) or a completed periodic round is live again
    next.interrupted = false
  }
  store.upsertTicket(next)
  return next
}
