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
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SseSink } from './sse.ts'
import type { MappingState } from './events.ts'
import { newMappingState } from './events.ts'

/** One bridge-owned session: its agent handle plus the currently-streaming run. */
export interface SessionRecord {
  readonly sessionId: SessionId
  readonly handle: AgentHandle
  /** The run whose SSE response is currently open, if any (one at a time). */
  active: ActiveRun | undefined
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
  private readonly ctx: Context
  private readonly records = new Map<string, SessionRecord>()

  constructor(ctx: Context) {
    this.ctx = ctx
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
    const record: SessionRecord = { sessionId, handle, active: undefined }
    this.records.set(sessionId, record)
    return record
  }

  /** Create fresh, or resume the persisted session; creation is the fallback, not the rule. */
  private async openHandle(sessionId: SessionId): Promise<AgentHandle> {
    try {
      return await this.ctx.agents.resume({ resumeSessionId: sessionId })
    } catch {
      // No persisted session under this id (first run on the thread).
      return this.ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
      })
    }
  }
}

/** Detach the active run when its response goes away (terminal event or client disconnect). */
export function detachActive(record: SessionRecord, runId: string): void {
  if (record.active?.runId === runId) record.active = undefined
}
