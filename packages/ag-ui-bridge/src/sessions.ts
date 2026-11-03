/**
 * Bridge-owned session registry.
 *
 * A session is "bridge-owned" once the bridge created or resumed it for a
 * threadId. Ownership is the isolation boundary from dsh's native Web UI:
 * native sessions never enter this registry, so the bridge never drives their
 * turns and its approval answerer passes their requests through untouched.
 *
 * threadId → sessionId is deterministic (`agui-<sanitized threadId>`), so a
 * client reconnecting after a bridge restart resumes the same persisted
 * session instead of silently forking the thread.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SseSink } from './sse.ts'
import type { MappingState } from './events.ts'
import { newMappingState } from './events.ts'

/** One captured approval: the bridge answers it when the client resumes the run. */
export interface PendingApproval {
  readonly toolName: string
  readonly callId: string | undefined
  readonly resolve: (outcome: ApprovalOutcome) => void
}

/** One bridge-owned session: its agent handle plus the currently-streaming run. */
export interface SessionRecord {
  readonly sessionId: SessionId
  readonly threadId: string
  readonly handle: AgentHandle
  /** The run whose SSE response is currently open, if any (one at a time). */
  active: ActiveRun | undefined
  /** Captured approvals awaiting a client resume answer, by interrupt id. */
  readonly pendings: Map<string, PendingApproval>
}

/** The live output side of one POST /agui run. */
export interface ActiveRun {
  readonly runId: string
  readonly sink: SseSink
  readonly mapper: MappingState
}

/** Session ids are workspace-log directory names: allow a conservative subset only. */
const SESSION_ID_MAX_CHARS = 64

/** Deterministic, filesystem-safe session id for a client thread id. */
export function sessionIdFor(threadId: string): SessionId {
  const clean = threadId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, SESSION_ID_MAX_CHARS)
  return `agui-${clean}` as SessionId
}

/** Registry of every session the bridge owns, keyed by session id. */
export class BridgeSessions {
  private readonly records = new Map<string, SessionRecord>()

  /**
   * The agents service captured during apply() — request handlers run outside
   * the plugin's injection scope, so a lazy `ctx.agents` read there throws
   * "without inject" (the ACP bridge learned this the hard way; see its
   * "capture the injected service during apply" note).
   */
  private readonly agents: AgentRegistry
  private readonly defaultModel: AgentDefaultModelConfig
  private readonly presets: AgentPresetRegistry

  constructor(agents: AgentRegistry, defaultModel: AgentDefaultModelConfig, presets: AgentPresetRegistry) {
    this.agents = agents
    this.defaultModel = defaultModel
    this.presets = presets
  }

  /** The bridge-owned record for a live agent, or undefined for foreign sessions. */
  ownsAgent(agent: Agent): SessionRecord | undefined {
    for (const record of this.records.values()) {
      if (record.handle.agent === agent) return record
    }
    return undefined
  }

  /** The bridge-owned record for a live session, or undefined for foreign sessions. */
  ownsSession(session: Session): SessionRecord | undefined {
    for (const record of this.records.values()) {
      if (record.handle.agent.session === session) return record
    }
    return undefined
  }

  /** Whether a session id currently has an open SSE run. */
  hasActiveRun(sessionId: SessionId): boolean {
    return this.records.get(sessionId)?.active !== undefined
  }

  /**
   * Return the bridge-owned agent for a threadId, creating the session on
   * first sight and resuming the persisted one after a bridge restart.
   */
  async ensure(threadId: string): Promise<SessionRecord> {
    const sessionId = sessionIdFor(threadId)
    const existing = this.records.get(sessionId)
    if (existing !== undefined) return existing
    const handle = await this.openHandle(sessionId)
    const record: SessionRecord = { sessionId, threadId, handle, active: undefined, pendings: new Map() }
    this.records.set(sessionId, record)
    return record
  }

  /** Drop a disposed session: the registry never drives a dead agent again. */
  drop(session: Session): void {
    for (const [id, record] of this.records) {
      if (record.handle.agent.session === session) this.records.delete(id)
    }
  }

  /**
   * Create fresh, or resume the persisted session; creation is the fallback,
   * not the rule. Composition parity with the web session-controller (its
   * `composeAgent`): mount the deployment default agent preset in setup —
   * without it the agent gets no preset tools at all (observed: only
   * working_directory) — and pass the deployment default model as agent
   * options so the request route and HiBuddy's `{{model}}` persona variable
   * resolve. dsh 0.2.1-rc.5 reads the route from agent options when no
   * durable selection exists.
   */
  private async openHandle(sessionId: SessionId): Promise<AgentHandle> {
    const selection = this.defaultModel.currentSelection()
    const preset = await this.presets.resolve()
    const mount = async (agentCtx: Context): Promise<void> => {
      await this.presets.mount(agentCtx, preset.id)
    }
    try {
      return await this.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: { ...selection },
        setup: mount,
      })
    } catch {
      // No persisted session under this id (first run on the thread).
      return this.agents.create({
        sessionId,
        meta: { cwd: process.cwd(), agentPreset: preset.id },
        agentOptions: { ...selection },
        setup: mount,
      })
    }
  }
}

/** Detach the active run when its response goes away (terminal event or client disconnect). */
export function detachActive(record: SessionRecord, runId: string): void {
  if (record.active?.runId === runId) record.active = undefined
}
