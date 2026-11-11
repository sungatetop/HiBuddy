/**
 * Worker-session orchestration (resident-design.md §7, D2).
 *
 * A worker session is an ORDINARY dsh session: `resident-worker-<ticketId>`
 * (deterministic id), created or resumed through the native AgentRegistry, so
 * it rides the same preset / model route / approval / persistence trunk as any
 * user session. The three-element composition is the web session-controller's
 * `composeAgent` pattern, already真机-verified by @hibuddy/ag-ui-bridge:
 *   1. `presets.mount(agentCtx, preset.id)` in setup (without it the session
 *      gets no preset tools — observed: only working_directory);
 *   2. `agentDefaultModel.currentSelection()` spread into agentOptions (route
 *      + HiBuddy's `{{model}}` persona variable resolve);
 *   3. `meta.agentPreset` on create.
 *
 * Working directory split (S7-B 补 2026-11-10): the session HEADER cwd is the
 * workspace root — dsh workspace membership is an exact canonical-cwd match,
 * so a per-ticket subdir would leave the worker session outside the delegated
 * workspace ("ungrouped") — while the EFFECTIVE working directory (what tools
 * default to) is moved into `<workspace>/resident-work/<ticket-short>` via the
 * working-directory service. The header stays the immutable "original
 * project", so the sandbox workspace-write root and the workspace grouping
 * both follow the workspace; L1 approval semantics stay unchanged (D4: no
 * danger-full-access).
 *
 * Round lifecycle: startRun → open (live / resume / create) → followup(goal)
 * → whenIdle (+ subagent drain) → flush → summarize → finalize. Success is the
 * headless criterion (last `turn/end` reason `completed`, no `agent/error`);
 * a periodic success returns working → pending with the scheduler-precomputed
 * next occurrence; failures move the ticket to `failed` with NO auto retry
 * (design §13.1). A `blocked` turn (approval pending) leaves the ticket
 * working with the worker session flagged `awaiting_approval` — B7's
 * approval/asked listener takes over from there.
 *
 * Handles are deliberately never disposed (dispose removes the session from
 * the store); finished workers stay idle in the registry and are reused via
 * `agents.get` on the next round or resumed from persistence after a restart.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionLogOffset, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
// Pulls the `subagents` service declaration into the cordis ServiceMap.
import type {} from '@deepseek-ai/dsh-subagent'
import type { ArtifactRef, Ticket } from './domain.ts'
import { scanArtifacts } from './artifacts.ts'
import { MessageService } from './messages.ts'
import { nextOccurrence, type TicketDispatcher } from './scheduler.ts'
import { transitionTicket } from './state-machine.ts'
import type { Store } from './store.ts'

/** Title-length cap so notification rows stay scannable in the panel. */
const TITLE_GOAL_MAX_CHARS = 60

/** Worker slots when the panel has not configured any (design §5, default 2). */
export const DEFAULT_WORKER_SLOTS = 2

/** Summary/report cap so SQLite rows stay small; full text lives in the session log. */
const REPORT_MAX_CHARS = 500

/** Core services the orchestrator cannot work without (missing → layer disabled). */
export interface WorkerDeps {
  /** Root host context, captured once in apply() (cordis injection-scope discipline). */
  readonly ctx: Context
  readonly agents: AgentRegistry
  readonly presets: AgentPresetRegistry
  readonly defaultModel: AgentDefaultModelConfig
}

/** One opened round: everything the drive phase needs to own the run. */
interface RoundContext {
  ticketId: string
  runId: number
  agent: Agent
  sessionId: SessionId
  prompt: string
  /** Round start instant (ISO); the receipt's `startedAt`. */
  startedAt: string
  /** The ticket's isolation working directory (artifact scan root). */
  workdir: string
}

/** Filesystem-safe short form of a ticket id for session/dir naming. */
export function shortId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32)
}

export function truncate(text: string, max = REPORT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The worker prompt: the user's goal plus the round context the orchestrator
 * is responsible for surfacing (late compensation / recovery after restart).
 */
export function buildPrompt(
  ticket: Ticket,
  priorRounds: number,
  info: { late: boolean; recovery: boolean },
): string {
  const notes: string[] = []
  if (info.recovery) {
    notes.push(
      '注意：宿主进程在上一轮执行期间重启，本会话由常驻编排层恢复。' +
        '请先检查工作目录与既有进度，避免重复任何已完成的外部动作，再继续完成目标。',
    )
  } else if (info.late) {
    notes.push('注意：本次触发是错过的到期时间的补偿执行，请照常完成目标。')
  } else if (priorRounds > 0) {
    notes.push('这是周期任务的例行新一轮执行。')
  }
  return ['请自主完成以下目标：', ticket.goal, ...notes].join('\n\n')
}

/**
 * Headless-style round summary over the owned event interval: the last
 * assistant text and the last turn-end reason decide the outcome.
 */
export function summarizeRound(
  session: Session,
  firstSeq: SessionLogOffset,
): { text: string; reason: TurnEndReason | undefined } {
  const events = session.snapshotEvents(firstSeq, session.seq)
  let started = false
  let text = ''
  let reason: TurnEndReason | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/**
 * The TicketDispatcher implementation over worker sessions. Also provides the
 * reconcile hook (`resumeWorker`) for tickets that were `working` at shutdown.
 */
export class WorkerOrchestrator implements TicketDispatcher {
  private readonly deps: WorkerDeps
  private readonly store: Store
  private readonly notifier: MessageService
  /** Ticket ids with an in-flight round — the slot accounting. */
  private readonly active = new Set<string>()
  private workspaceRoot: string | undefined

  constructor(deps: WorkerDeps, store: Store, notifier?: MessageService) {
    this.deps = deps
    this.store = store
    this.notifier = notifier ?? new MessageService(store)
  }

  /** Concurrent worker slots; panel-editable via store settings (design §8). */
  slots(): number {
    const configured = this.store.getSetting<number>('workerSlots')
    return typeof configured === 'number' && configured >= 1 ? Math.floor(configured) : DEFAULT_WORKER_SLOTS
  }

  /** True when at least one worker slot is free (consulted before any state change). */
  canDispatch(): boolean {
    return this.active.size < this.slots()
  }

  /**
   * Take the fired round (scheduler already persisted the trigger and moved
   * the ticket to `working`). Runs asynchronously; open failures move the
   * ticket to `failed` (no auto retry, design §13.1).
   */
  dispatch(ticket: Ticket, info: { late: boolean }): void {
    if (this.active.has(ticket.id)) return
    this.active.add(ticket.id)
    void (async () => {
      try {
        const round = await this.openRound(ticket, { ...info, recovery: false })
        await this.driveRound(round, { ...info, recovery: false })
      } catch (error) {
        // openRound already finalized the failure; anything here is a bug —
        // log and release the slot.
        console.error('[hibuddy-resident] worker round crashed:', errorMessage(error))
      } finally {
        this.active.delete(ticket.id)
      }
    })()
  }

  /**
   * Reconcile hook: resume the worker session of a ticket that was `working`
   * at shutdown and continue its round with a recovery note. Returns true only
   * when the session was actually reopened (the round then runs detached); a
   * refusal (no slot / open failure) lets reconciliation mark the ticket
   * `interrupted` instead.
   */
  async resumeWorker(ticket: Ticket): Promise<boolean> {
    if (this.active.has(ticket.id) || !this.canDispatch()) return false
    this.active.add(ticket.id)
    try {
      const round = await this.openRound(ticket, { late: false, recovery: true })
      void (async () => {
        try {
          await this.driveRound(round, { late: false, recovery: true })
        } catch (error) {
          console.error('[hibuddy-resident] recovered round crashed:', errorMessage(error))
        } finally {
          this.active.delete(ticket.id)
        }
      })()
      return true
    } catch {
      // openRound recorded the failed run; reconciliation marks interrupted
      this.active.delete(ticket.id)
      return false
    }
  }

  /**
   * The sandbox write root for a round: the ticket's delegated workspace when
   * one was chosen, else the process-level workspace root (legacy tickets).
   * The workspace must exist — a vanished workspace fails the round instead of
   * silently recreating a tree somewhere unexpected.
   */
  private async resolveWorkspaceRoot(ticket: Ticket): Promise<string> {
    if (ticket.workspace !== undefined && ticket.workspace !== null) {
      if (!existsSync(ticket.workspace) || !statSync(ticket.workspace).isDirectory()) {
        throw new Error(`workspace "${ticket.workspace}" no longer exists`)
      }
      return ticket.workspace
    }
    if (this.workspaceRoot !== undefined) return this.workspaceRoot
    const fs = this.deps.ctx.get('fs')
    this.workspaceRoot = fs ? fs.processPath(await fs.resolve('.')) : process.cwd()
    return this.workspaceRoot
  }

  /**
   * Account the worker session under its workspace record (grouping surfaces
   * read `workspace.sessionIds`, which only lists sessions the registry
   * attached). The web session-controller does this on session create; a
   * missing/absent registry or a failed attach only affects grouping, so it
   * warns instead of failing the round.
   */
  private async attachToWorkspace(sessionId: SessionId, root: string): Promise<void> {
    const registry = this.deps.ctx.get('workspaceRegistry') as
      | {
          resolveByPath(path: string): Promise<
            | { attachSession(id: string): Promise<void> }
            | undefined
          >
        }
      | undefined
    if (registry === undefined) return
    try {
      const workspace = await registry.resolveByPath(root)
      if (workspace !== undefined) await workspace.attachSession(sessionId)
    } catch (error) {
      console.warn(
        `[hibbuddy-resident] could not attach worker session '${sessionId}' to workspace '${root}': ${errorMessage(error)}`,
      )
    }
  }

  /** startRun → open the worker session (live / resume / create) → record it. */
  private async openRound(
    ticket: Ticket,
    info: { late: boolean; recovery: boolean },
  ): Promise<RoundContext> {
    const sessionId = brandString(`resident-worker-${shortId(ticket.id)}`) as SessionId
    const startedAt = new Date().toISOString()
    const runId = this.store.startRun(
      ticket.id,
      startedAt,
      info.recovery ? 'recovery resume after host restart' : info.late ? 'late compensation' : undefined,
    )
    try {
      const root = await this.resolveWorkspaceRoot(ticket)
      // Effective working directory (tools default here); the session HEADER
      // cwd stays the workspace root so the session groups under the delegated
      // workspace (exact-cwd membership) and the sandbox root is the workspace.
      const cwd = join(root, 'resident-work', shortId(ticket.id))
      mkdirSync(cwd, { recursive: true })

      // composeAgent three elements (D2) — bridge-verified parity.
      const selection = this.deps.defaultModel.currentSelection()
      const preset = await this.deps.presets.resolve()
      const agentOptions = { ...selection }
      const mount = async (agentCtx: Context): Promise<void> => {
        await this.deps.presets.mount(agentCtx, preset.id)
      }

      let agent: Agent
      const live = this.deps.agents.get(sessionId)
      if (live !== undefined) {
        agent = live
      } else if (this.store.getWorkerSession(ticket.id) !== undefined) {
        // A previous round persisted a session under this id — adopt it.
        agent = (
          await this.deps.agents.resume({ resumeSessionId: sessionId, agentOptions, setup: mount })
        ).agent
      } else {
        agent = (
          await this.deps.agents.create({
            sessionId,
            meta: { cwd: root, agentPreset: preset.id },
            agentOptions,
            setup: mount,
          })
        ).agent
      }

      // Move the effective working directory into the ticket's isolation dir
      // (the projection persists it, so a later resume replays the same dir).
      await this.deps.ctx.get('workingDirectory')?.set(agent, cwd)

      // Account the session under the workspace record: grouping surfaces
      // (workspace.sessionIds) only show sessions the registry ATTACHED — the
      // web session-controller does the same on session create, and without it
      // the header-cwd match alone still leaves the worker session ungrouped.
      await this.attachToWorkspace(sessionId, root)

      this.store.upsertWorkerSession({ ticketId: ticket.id, sessionId, state: 'working' })
      this.store.upsertTicket({ ...ticket, sessionId, updatedAt: new Date().toISOString() })

      const priorRounds = Math.max(0, this.store.listRuns(ticket.id).length - 1)
      const prompt =
        `${buildPrompt(ticket, priorRounds, info)}\n\n` +
        `你的工作目录是 ${cwd}（任务中的相对路径以它为基准；“工作目录”即指此处）。`
      return { ticketId: ticket.id, runId, agent, sessionId, prompt, startedAt, workdir: cwd }
    } catch (error) {
      this.store.finishRun(runId, new Date().toISOString(), 'failed', `worker session open failed: ${errorMessage(error)}`)
      if (info.recovery) throw error
      // Dispatch failure → ticket failed, no auto retry (design §13.1).
      const current = this.store.getTicket(ticket.id)
      if (current && current.state === 'working') {
        transitionTicket(this.store, current, 'failed', {
          summary: `worker 会话打开失败：${truncate(errorMessage(error))}`,
          sessionId,
        })
        // System problem → inbound event; the butler relays it (ADR-011).
        this.notifier.postInbound({
          kind: 'event',
          refs: { ticketId: ticket.id },
          title: `任务启动失败：${truncate(ticket.goal, TITLE_GOAL_MAX_CHARS)}`,
          text: `worker 会话打开失败：${truncate(errorMessage(error))}`,
        })
      }
      this.store.upsertWorkerSession({ ticketId: ticket.id, sessionId, state: 'blocked' })
      throw error
    }
  }

  /** Fire the goal turn, wait for quiescence, then finalize the outcome. */
  private async driveRound(round: RoundContext, info: { late: boolean; recovery: boolean }): Promise<void> {
    const { agent } = round
    const firstSeq = agent.session.seq
    let failure: unknown
    let failureAt = -1
    // The headless failure pattern: `agent/error` arms the failure; a later
    // turn/end at or past the failure offset clears it (the turn recovered).
    const stopErrors = this.deps.ctx.on('agent/error', (payload) => {
      if (payload.agent === agent) {
        failure = payload.error
        failureAt = agent.session.seq
      }
    })
    const stopTerminals = this.deps.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end' && failure !== undefined && event.seq >= failureAt) {
        failure = undefined
      }
    })
    let outcome: { text: string; reason: TurnEndReason | undefined }
    try {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: round.prompt }],
          source: { kind: 'user' },
        }),
      )
      // Quiescence = idle AND no pending subagent children (headless parity).
      while (true) {
        await agent.whenIdle()
        const idleSeq = agent.session.seq
        const childrenPending = await this.deps.ctx.get('subagents')?.waitForChildren(agent)
        if (childrenPending !== true && agent.status === 'idle' && agent.session.seq === idleSeq) break
      }
    } catch (error) {
      failure = failure ?? error
    } finally {
      stopErrors()
      stopTerminals()
    }
    await this.deps.ctx.get('sessions')?.flush(agent.session)
    outcome = summarizeRound(agent.session, firstSeq)
    this.finalize(round, info, outcome, failure)
  }

  /** Persist the round outcome and the resulting ticket transition. */
  private finalize(
    round: RoundContext,
    info: { late: boolean; recovery: boolean },
    outcome: { text: string; reason: TurnEndReason | undefined },
    failure: unknown,
  ): void {
    const now = new Date().toISOString()
    const reasonKind = outcome.reason?.kind

    if (failure === undefined && reasonKind === 'completed') {
      const summary = truncate(outcome.text)
      // Audit detail keeps the round's provenance markers before the outcome.
      const detail = [
        info.recovery ? 'recovery resume after host restart' : undefined,
        info.late ? 'late compensation' : undefined,
        summary,
      ]
        .filter(Boolean)
        .join(' | ')
      const current = this.store.getTicket(round.ticketId)
      if (current && current.state === 'working') {
        if (current.period) {
          // Periodic success → pending for the next round; keep the
          // scheduler-precomputed occurrence, recompute only when stale.
          let nextRunAt = current.nextRunAt
          if (!nextRunAt || nextRunAt <= now) {
            const base = nextRunAt ? Date.parse(nextRunAt) : Date.now()
            nextRunAt = nextOccurrence(base, current.period.intervalMs, Date.now())
          }
          transitionTicket(this.store, current, 'pending', { summary, sessionId: round.sessionId, nextRunAt })
        } else {
          transitionTicket(this.store, current, 'completed', { summary, sessionId: round.sessionId })
        }
        // Worker receipt → inbound to the butler, who decides what to tell the
        // user (ADR-011: only the butler speaks to the user). Keyed per round
        // (perception B12′ §5.4) so periodic tickets with identical summaries
        // still deliver every round. The data block is the enriched receipt
        // (B12′ §5.3): outcome/runId/timing + the host-side artifact scan.
        const finishedAt = new Date().toISOString()
        const artifacts = this.scanRoundArtifacts(round)
        this.notifier.postInbound({
          kind: 'receipt',
          refs: { ticketId: round.ticketId, sessionId: round.sessionId },
          title: `任务完成：${truncate(current.goal, TITLE_GOAL_MAX_CHARS)}`,
          text: summary !== '' ? summary : '本轮已完成，未产生摘要文本。',
          idempotencyKey: `receipt:${round.ticketId}:${round.runId}`,
          data: {
            outcome: current.period ? 'periodic' : 'completed',
            runId: round.runId,
            startedAt: round.startedAt,
            finishedAt,
            durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(round.startedAt)),
            ...(info.late ? { late: true } : {}),
            ...(info.recovery ? { recovery: true } : {}),
            artifacts,
          },
        })
      }
      this.store.finishRun(round.runId, now, 'ok', detail)
      this.store.upsertWorkerSession({
        ticketId: round.ticketId,
        sessionId: round.sessionId,
        state: 'idle',
        lastReport: summary,
      })
      return
    }

    if (failure === undefined && reasonKind === 'blocked') {
      // Approval pending: B7's approval/asked listener promotes the ticket and
      // the answer path resumes the turn. Keep the durable trail, free nothing.
      this.store.finishRun(round.runId, now, 'awaiting_approval', 'turn blocked (awaiting user decision)')
      this.store.upsertWorkerSession({
        ticketId: round.ticketId,
        sessionId: round.sessionId,
        state: 'awaiting_approval',
      })
      return
    }

    const detail =
      failure !== undefined
        ? `agent error: ${truncate(errorMessage(failure))}`
        : `turn ended with reason "${reasonKind}"${info.recovery ? ' (recovered round)' : ''}`
    console.error(`[hibuddy-resident] ticket ${round.ticketId} round failed: ${detail}`)
    this.store.finishRun(round.runId, now, 'failed', detail)
    // Failure → ticket failed, no auto retry (design §13.1).
    const current = this.store.getTicket(round.ticketId)
    if (current && current.state === 'working') {
      transitionTicket(this.store, current, 'failed', {
        summary: truncate(detail),
        sessionId: round.sessionId,
      })
      // System problem → inbound event; the butler relays it (ADR-011).
      this.notifier.postInbound({
        kind: 'event',
        refs: { ticketId: round.ticketId, sessionId: round.sessionId },
        title: `任务失败：${truncate(current.goal, TITLE_GOAL_MAX_CHARS)}`,
        text: truncate(detail),
      })
    }
    this.store.upsertWorkerSession({
      ticketId: round.ticketId,
      sessionId: round.sessionId,
      state: 'blocked',
      lastReport: truncate(detail),
    })
  }

  /**
   * Host-side artifact scan over the round's working directory (B12′ §5.3).
   * Files modified at/after the round start, newest first, capped at 20. A
   * broken scan degrades to `[]` and only warns — it must never fail a receipt.
   */
  private scanRoundArtifacts(round: RoundContext): ArtifactRef[] {
    try {
      return scanArtifacts(round.workdir, Date.parse(round.startedAt) - 1000)
    } catch (error) {
      console.warn(
        `[hibuddy-resident] artifact scan failed for ticket ${round.ticketId}: ${errorMessage(error)}`,
      )
      return []
    }
  }
}
