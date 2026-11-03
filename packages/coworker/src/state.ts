/**
 * Process-local, session-scoped approval state (PRD SR-01).
 *
 * 免再询授权范围 = 当前会话 × 当前工具 × 当前风险等级。In-memory only:
 * a new session id starts clean, a process restart clears everything, and
 * nothing is persisted — the durable audit trail stays in the native
 * `approval/asked` / `approval/decided` session events (FR-08).
 */

/** One session-scoped "don't ask again" authorization for a tool. */
export interface GrantRecord {
  readonly sessionId: string
  readonly toolName: string
}

/** Grants (session × tool) and consecutive-rejection counters (session × tool). */
export class ApprovalSessionState {
  readonly #grants = new Map<string, Set<string>>()
  readonly #strikes = new Map<string, Map<string, number>>()

  /** Record a session-scoped grant for one tool. */
  grant(sessionId: string, toolName: string): void {
    let tools = this.#grants.get(sessionId)
    if (tools === undefined) {
      tools = new Set<string>()
      this.#grants.set(sessionId, tools)
    }
    tools.add(toolName)
  }

  /** Withdraw one grant; true when it existed. */
  revoke(sessionId: string, toolName: string): boolean {
    return this.#grants.get(sessionId)?.delete(toolName) ?? false
  }

  /** Whether the session holds a grant for the tool (免再询命中). */
  hasGrant(sessionId: string, toolName: string): boolean {
    return this.#grants.get(sessionId)?.has(toolName) ?? false
  }

  /** Snapshot of all live grants (diagnostics endpoint payload). */
  listGrants(): GrantRecord[] {
    const records: GrantRecord[] = []
    for (const [sessionId, tools] of this.#grants) {
      for (const toolName of tools) records.push({ sessionId, toolName })
    }
    return records
  }

  /** Count one rejection; returns the new consecutive count for the run. */
  addStrike(sessionId: string, toolName: string): number {
    const perSession = this.#strikes.get(sessionId)
    const tools = perSession ?? new Map<string, number>()
    if (perSession === undefined) this.#strikes.set(sessionId, tools)
    const next = (tools.get(toolName) ?? 0) + 1
    tools.set(toolName, next)
    return next
  }

  /** Current consecutive-rejection count for the tool in this session's run. */
  strikesOf(sessionId: string, toolName: string): number {
    return this.#strikes.get(sessionId)?.get(toolName) ?? 0
  }

  /** An allow clears the consecutive-rejection streak for the tool. */
  clearStrikesFor(sessionId: string, toolName: string): void {
    this.#strikes.get(sessionId)?.delete(toolName)
  }

  /** A new run (turn/start) opens with a clean rejection streak. */
  clearStrikes(sessionId: string): void {
    this.#strikes.delete(sessionId)
  }

  /** The session is gone — drop every trace of it. */
  dropSession(sessionId: string): void {
    this.#grants.delete(sessionId)
    this.#strikes.delete(sessionId)
  }
}
