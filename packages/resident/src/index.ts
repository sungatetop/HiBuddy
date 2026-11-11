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
 * B5: the monitor event source (SourceKind registry) + two-stage filtering —
 * lightweight check sessions emit triggers; the filter's gate (deterministic)
 * and assessment (LLM, observe mode by default) decide whether a hit becomes
 * a would-act record or an inferred-mandate ticket.
 * B6: the notification surface — one shared NotificationService is the single
 * write path for worker results/failures, observe-mode reports, and system
 * problems; persist before deliver, idempotency keys, do-not-disturb window,
 * and a startup pass that re-reaches recorded-but-undelivered rows.
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerResidentAgui } from './agui.ts'
import { registerResidentApi } from './api.ts'
import { ApprovalBroker } from './approvals.ts'
import { ButlerRuntime } from './butler.ts'
import { EdgeDetector } from './edge.ts'
import { FilterPipeline } from './filter.ts'
import { MonitorSource } from './monitor.ts'
import { acquireStateLock, type StateLock } from './lock.ts'
import { MessageService } from './messages.ts'
import { reconcile, type ReconcileHooks } from './reconcile.ts'
import { clearResidentService, setResidentService } from './service-ref.ts'
import { Scheduler } from './scheduler.ts'
import { SessionChecker } from './session-check.ts'
import { SourceRegistry, type TriggerEmitter } from './sources.ts'
import { resolveStateDir, type ResidentConfig } from './state-dir.ts'
import { Store } from './store.ts'
import { errorMessage, WorkerOrchestrator, type WorkerDeps } from './worker.ts'

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

/** Source-kind registry (B5: monitor) + filter pipeline; stopped on dispose. */
let sources: SourceRegistry | undefined

/** The resident butler (ADR-011): the user-facing Agent Loop + tool service. */
let butler: ButlerRuntime | undefined

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

  // B6′: the single conversation-ledger write path shared by worker/filter/monitor.
  // Every inbound row wakes the butler pump (ADR-011 D8).
  const notifier = new MessageService(store, { onInbound: () => butler?.wake() })

  // B4: worker orchestration over ordinary dsh sessions. The inject list
  // guarantees the three core services exist; the reconciler uses the same
  // orchestrator to resume tickets that were working at shutdown.
  const deps: WorkerDeps = { ctx, agents: ctx.agents, presets: ctx.agentPresets, defaultModel: ctx.agentDefaultModel }
  const orchestrator = new WorkerOrchestrator(deps, store, notifier)
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

  // B6′ startup pass: reconcile just re-armed awaiting-approval delivery flags;
  // deliverPending re-reaches every recorded-but-undelivered unread row (rows
  // silenced by the do-not-disturb window stay pending by design, §9).
  logger.info('messages re-armed (delivered=%d)', notifier.deliverPending())

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

  // B5: poll-based event sources over the SourceKind registry (§4). Monitor
  // checks run through a real session (SessionChecker); every emitted trigger
  // is persisted first, then handed to the two-stage filter (§6) — observe
  // mode is the default, so hits only record would-act verdicts until the
  // panel switches `observeMode` off.
  const checker = new SessionChecker(deps)
  const pipeline = new FilterPipeline(store, {
    assessor: checker,
    observeMode: () => store!.getSetting<boolean>('observeMode') ?? true,
    notifier,
  })
  const emit: TriggerEmitter = (trigger) => {
    store!.saveTrigger(trigger)
    void pipeline.handle(trigger)
  }
  const registry = new SourceRegistry()
  registry.register(new MonitorSource(store, checker, { notifier }))
  const started = registry.startAll(store, emit)
  sources = registry
  logger.info('event sources started (armed instances: %d)', started)

  // ADR-011: the butler is the only Agent Loop facing the user. It is mounted
  // with the small hibbuddy-butler preset (whose tools plugin resolves the
  // `resident` service provided here), consumes the inbound queue one turn at
  // a time, and answers only through send_message_to_user.
  // ADR-011 D9: worker approvals are routed into the butler conversation.
  const approvals = new ApprovalBroker(store, notifier)
  const removeApprovalAnswerer = approvals.install(ctx)

  butler = new ButlerRuntime(deps, store, notifier, approvals, { workspace: config?.workspace })
  setResidentService(butler)
  await butler.start()
  // B12′ D4: L1 edge events — stalled/resumed workers and unanswered-question
  // reminders, polled on a 30s scan (settings `perceptionEvents` master switch).
  const edge = new EdgeDetector(ctx, store, notifier)
  edge.start()
  logger.info('edge detector started (scan %ds, stall %dm, reminder %dm)', 30, 10, 30)
  // Chat data routes for the WeChat-style client panel (same trust fence as
  // dsh's own routes; headless compositions never register them).
  registerResidentApi(ctx, () => butler)
  // ADR-011 D10: /agui carries the butler agent only — worker sessions never
  // cross that boundary (the per-session bridge is the debug surface).
  registerResidentAgui(ctx, () => butler)
  logger.info(
    'butler started (session: %s, pending inbound: %d)',
    butler.sessionId,
    store.countPendingInbound(),
  )

  return () => {
    edge.stop()
    butler?.stop()
    butler = undefined
    clearResidentService()
    removeApprovalAnswerer()
    sources?.stopAll()
    sources = undefined
    scheduler?.stop()
    scheduler = undefined
    store?.close()
    store = undefined
    lock?.release()
    lock = undefined
  }
}
