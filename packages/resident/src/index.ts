/**
 * HiBuddy resident layer plugin — host half.
 *
 * S7-B (resident-design.md): worker sessions are ordinary dsh sessions; this
 * plugin is the deterministic orchestration layer ABOVE them — event sources,
 * two-stage filtering, tickets, worker dispatch, notifications, durable state.
 * The user only states goals; worker sessions are created/resumed/stopped by
 * this layer and never faced directly.
 *
 * B2: persistence boot sequence on top of the B1 stateDir gate —
 * single-instance lock (proper-lockfile) → SQLite store (WAL, schema
 * migrations) → startup reconciliation (working tickets interrupted/resumed,
 * awaiting-approval notifications re-armed).
 * B3: the scheduler (event source for scheduled tasks + ticket state machine)
 * polls the ticket schedule index.
 * B4: the worker orchestrator implements the dispatcher — every fired round
 * opens an ordinary dsh worker session (`resident-worker-<ticketId>`) with the
 * bridge-verified composeAgent composition, drives the goal turn to
 * quiescence, and persists the outcome; the same orchestrator resumes tickets
 * that were working at shutdown.
 */

import type { Context } from '@deepseek-ai/cordis'
import { acquireStateLock, type StateLock } from './lock.ts'
import { reconcile, type ReconcileHooks } from './reconcile.ts'
import { Scheduler } from './scheduler.ts'
import { resolveStateDir, type ResidentConfig } from './state-dir.ts'
import { Store } from './store.ts'
import { WorkerOrchestrator, type WorkerDeps } from './worker.ts'

/** Cordis function-plugin name. */
export const name = 'hibuddy-resident'

/**
 * Core agent services the worker orchestrator cannot work without. Declaring
 * them delays the plugin's apply until the agent trunk is ready (the bridge
 * learned that request callbacks run outside the injection scope; all service
 * reads therefore happen here, once, and the references are captured).
 */
export const inject = ['agents', 'agentDefaultModel', 'agentPresets']

/** Resolved after the gate passes; consumed by B2+ (persistence, scheduler). */
let stateDir: string | undefined

/** Current stateDir, once the gate has passed. */
export function currentStateDir(): string | undefined {
  return stateDir
}

/** Open store + held lock; released on dispose. */
let store: Store | undefined
let lock: StateLock | undefined

/** Timer-driven event source over the ticket schedule index; stopped on dispose. */
let scheduler: Scheduler | undefined

/** Open store accessor for later layers (scheduler, panel API). */
export function currentStore(): Store | undefined {
  return store
}

/**
 * Resident orchestrator entry: enforce the stateDir gate, then take the
 * single-instance lock, open persistence, reconcile durable state, and arm
 * the scheduler with the worker dispatcher (B4) over the ticket index.
 * @param ctx - host root context.
 * @param config - raw config from the patch row (stateDir required — D3).
 * @returns a disposer closing the store and releasing the lock on unload.
 */
export async function apply(ctx: Context, config?: ResidentConfig): Promise<() => void> {
  const logger = ctx.logger('hibuddy-resident')
  stateDir = resolveStateDir(config)

  lock = await acquireStateLock(stateDir)
  store = Store.open(stateDir)

  // B4: worker orchestration over ordinary dsh sessions. The inject list
  // guarantees the three core services exist; the reconciler uses the same
  // orchestrator to resume tickets that were working at shutdown.
  const deps: WorkerDeps = { ctx, agents: ctx.agents, presets: ctx.agentPresets, defaultModel: ctx.agentDefaultModel }
  const orchestrator = new WorkerOrchestrator(deps, store)
  const hooks: ReconcileHooks = { resumeWorker: (ticket) => orchestrator.resumeWorker(ticket) }

  const summary = await reconcile(store, new Date().toISOString(), hooks)
  logger.info(
    'started, stateDir: %s (reconcile: resumed=%d interrupted=%d awaitingApproval=%d reNotified=%d missedOneShots=%d)',
    stateDir,
    summary.resumed,
    summary.interrupted,
    summary.awaitingApproval,
    summary.reNotified,
    summary.missedOneShots,
  )

  // Scheduler armed with the dispatcher — scheduled firing is now live.
  scheduler = new Scheduler(store, { dispatcher: orchestrator })
  const fired = scheduler.start()
  logger.info(
    'scheduler started (firedOneShots=%d lateOneShots=%d firedPeriodic=%d skippedPeriodic=%d deferredNoSlot=%d)',
    fired.firedOneShots,
    fired.lateOneShots,
    fired.firedPeriodic,
    fired.skippedPeriodic,
    fired.deferredNoSlot,
  )

  return () => {
    scheduler?.stop()
    scheduler = undefined
    store?.close()
    store = undefined
    lock?.release()
    lock = undefined
  }
}
