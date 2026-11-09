/**
 * Butler runtime (ADR-011 D1/D8): the resident agent the user actually talks to.
 *
 * It is a single long-lived dsh session (`resident-butler`) mounted with the
 * small `hibbuddy-butler` preset. Its inbox is the conversation ledger:
 * user messages, event envelopes (monitor hits, system problems), worker
 * receipts and approval events all land as inbound rows; the pump feeds one
 * batch per turn (single-flight), and the butler answers only through the
 * `send_message_to_user` tool. Its thinking, tool calls and worker activity
 * never reach the UI — the UI reads the ledger, not the session log.
 *
 * Delegation: `createSession` writes a ticket and lets the scheduler dispatch
 * it (≤ one tick later); the worker session id is deterministic, so the tool
 * can answer immediately. `sendToSession` / `getSession` / `listSessions` /
 * `cancelSession` are the command-and-monitor surface.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { normalize } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalBrokerFace, PendingApproval } from './approvals.ts'
import type { Message, ResidentSettings, Ticket } from './domain.ts'
import { parseQuietWindow, type MessageService } from './messages.ts'
import { transitionTicket } from './state-machine.ts'
import type { Store } from './store.ts'
import { errorMessage, shortId } from './worker.ts'

/** Preset id declared by this bundle's patch (`hibuddy-butler`). */
export const BUTLER_PRESET_ID = 'hibbuddy-butler'

/** Deterministic butler session id (single user, single conversation). */
export const BUTLER_SESSION_ID = 'resident-butler'

/** Inbound rows consumed per turn; extra rows wait for the next turn. */
const BATCH_LIMIT = 20

/** Services the butler cannot work without. */
export interface ButlerDeps {
  readonly ctx: Context
  readonly agents: AgentRegistry
  readonly presets: AgentPresetRegistry
  readonly defaultModel: AgentDefaultModelConfig
}

/** One worker session as the butler sees it. */
export interface SessionInfo {
  sessionId: string
  ticketId: string
  goal: string
  state: string
  /** Workspace the worker executes under (canonical path), when one was chosen. */
  workspace?: string
  lastReport?: string
  summary?: string
}

/** One dsh workspace record the butler may delegate into. */
export interface WorkspaceInfo {
  id: string
  path: string
  title: string
}

/** What `create_session` returns. */
export interface CreatedSession {
  ticketId: string
  sessionId: string
  state: 'pending'
  /** Canonical workspace path the worker will run under (absent when unbound). */
  workspace?: string
}

/**
 * The service the butler tools consume (provided on the root context as
 * `resident`; the tools plugin mounts inside the preset's agent scope).
 */
export interface ResidentButler {
  readonly sessionId: string
  /** User text from the chat UI; records the inbound row and wakes the pump. */
  postUserMessage(text: string): void
  /** Event envelope / receipt / approval event from the host. */
  postEvent(input: {
    kind: 'event' | 'receipt' | 'approval'
    text: string
    refs?: Message['refs']
    idempotencyKey?: string
  }): void
  /** The butler's only outbound channel (`send_message_to_user`). */
  sendMessage(input: {
    text: string
    kind: 'text' | 'question' | 'report' | 'system'
    replyTo?: string
  }): { id: string; recorded: boolean }
  /** Delegates a goal to a new worker session (ticket + deterministic id). */
  createSession(input: { goal: string; title?: string; workspace?: string }): CreatedSession
  /** Registered dsh workspaces the butler may delegate into. */
  listWorkspaces(): WorkspaceInfo[]
  /** Adds an instruction to a live worker session. */
  sendToSession(sessionId: string, text: string): { ok: boolean; error?: string }
  getSession(sessionId: string): SessionInfo | undefined
  listSessions(): SessionInfo[]
  cancelSession(sessionId: string): { ok: boolean; error?: string }
  /** Pending worker approvals routed into this conversation (ADR-011 D9). */
  pendingApprovals(): PendingApproval[]
  /** Butler decision on one pending approval (dangerous ones need a user reply first). */
  resolveApproval(id: string, approved: boolean): { ok: boolean; error?: string }
  /** Chat transcript for the UI: user text + butler outbound (events/receipts hidden). */
  messages(limit?: number): Message[]
  unreadCount(): number
  /** Observe outbound rows (butler messages + approval cards) as they are recorded. */
  onOutbound(listener: (message: Message) => void): () => void
  /** Resolves once the current turn (if any) finished and the inbound queue is empty. */
  whenIdle(): Promise<void>
  /** Current panel-editable settings (design §8, explicit save). */
  settings(): ResidentSettings
  /** Persists a settings patch and returns the resulting snapshot. */
  saveSettings(patch: ResidentSettings): ResidentSettings
  /** Live status for the chat UI ("处理中"). */
  status(): { sessionId: string; state: string; pendingInbound: number }
}

/** Renders a batch of inbound rows as one user turn for the butler. */
export function renderInbound(batch: readonly Message[]): string {
  const lines = batch.map((message) => {
    switch (message.kind) {
      case 'text':
        return `【用户】${message.text}`
      case 'event':
        return `【事件】${message.text}`
      case 'receipt':
        return `【任务回执】${message.text}`
      case 'approval':
        return `【审批请求】${message.text}`
      default:
        return `【${message.kind}】${message.text}`
    }
  })
  return [
    '以下是你收到的输入（用户消息 / 事件 / 任务回执 / 审批请求）。',
    '事件与回执不是你与用户的对话内容：自行判断是否需要行动，需要时用 send_message_to_user 告知用户。',
    '',
    ...lines,
  ].join('\n')
}

export class ButlerRuntime implements ResidentButler {
  readonly sessionId = BUTLER_SESSION_ID
  private readonly deps: ButlerDeps
  private readonly store: Store
  private readonly ledger: MessageService
  private readonly approvals: ApprovalBrokerFace | undefined
  private agent: Agent | undefined
  private pumping = false
  private stopped = false
  private workspaceRoot: string | undefined
  private workspaceCache: WorkspaceInfo[] | undefined
  private readonly preferredWorkspace: string | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private idleWaiters: Array<() => void> = []

  constructor(
    deps: ButlerDeps,
    store: Store,
    messages: MessageService,
    approvals?: ApprovalBrokerFace,
    options: { workspace?: string } = {},
  ) {
    this.deps = deps
    this.store = store
    this.ledger = messages
    this.approvals = approvals
    this.preferredWorkspace = options.workspace
  }

  /** Opens (or resumes) the butler session; safe to call once per process. */
  async start(): Promise<void> {
    const sessionId = brandString(this.sessionId) as SessionId
    const live = this.deps.agents.get(sessionId)
    if (live !== undefined) {
      this.agent = live
    } else {
      // Bind before opening the session: the workspace plugin may still be
      // initializing, and the session's cwd must be the workspace root.
      await this.loadWorkspaces()
      const cwd = await this.resolveWorkspaceRoot()
      mkdirSync(cwd, { recursive: true })
      const selection = this.deps.defaultModel.currentSelection()
      const preset = await this.deps.presets.resolve(BUTLER_PRESET_ID)
      const agentOptions = { ...selection }
      const mount = async (agentCtx: Context): Promise<void> => {
        await this.deps.presets.mount(agentCtx, preset.id)
      }
      const create = async (): Promise<Agent> =>
        (
          await this.deps.agents.create({
            sessionId,
            meta: { cwd, agentPreset: preset.id },
            agentOptions,
            setup: mount,
          })
        ).agent
      if (this.store.getButlerState()?.sessionId === this.sessionId) {
        try {
          this.agent = (await this.deps.agents.resume({ resumeSessionId: sessionId, agentOptions, setup: mount })).agent
        } catch (error) {
          // A missing/corrupt persisted log must not take the resident layer
          // down: the ledger (the user-facing transcript) is independent, so
          // open a fresh butler session instead.
          console.warn('[hibbuddy-resident] butler resume failed, creating a fresh session:', errorMessage(error))
          this.agent = await create()
        }
      } else {
        this.agent = await create()
      }
    }
    this.store.upsertButlerState({
      sessionId: this.sessionId,
      state: 'idle',
      lastActiveAt: new Date().toISOString(),
    })
    this.wake()
  }

  stop(): void {
    this.stopped = true
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
  }

  /** Records the user's chat message and lets the pump pick it up. */
  postUserMessage(text: string): void {
    this.ledger.postInbound({ kind: 'text', text })
    this.wake()
  }

  /** Records an event envelope / receipt / approval event and wakes the pump. */
  postEvent(input: {
    kind: 'event' | 'receipt' | 'approval'
    text: string
    refs?: Message['refs']
    idempotencyKey?: string
  }): void {
    this.ledger.postInbound(input)
    this.wake()
  }

  /** Serializes turns: at most one butler turn is in flight at any time. */
  wake(): void {
    if (this.stopped || this.pumping || this.agent === undefined) return
    if (this.ledger.pendingInbound(1).length === 0) return
    void this.pump()
  }

  status(): { sessionId: string; state: string; pendingInbound: number } {
    return {
      sessionId: this.sessionId,
      state: this.pumping ? 'working' : 'idle',
      pendingInbound: this.store.countPendingInbound(),
    }
  }

  /**
   * The user-facing transcript: user text and every outbound row. Event
   * envelopes and worker receipts are internal inputs and stay invisible.
   */
  messages(limit = 200): Message[] {
    return this.ledger
      .list({ oldestFirst: true, limit: 400 })
      .filter((message) => message.direction === 'out' || message.kind === 'text')
      .slice(-limit)
  }

  unreadCount(): number {
    return this.ledger.unreadCount()
  }

  onOutbound(listener: (message: Message) => void): () => void {
    return this.ledger.onOutbound(listener)
  }

  whenIdle(): Promise<void> {
    if (!this.pumping && this.store.countPendingInbound() === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  settings(): ResidentSettings {
    const workerSlots = this.store.getSetting<number>('workerSlots')
    const observeMode = this.store.getSetting<boolean>('observeMode')
    const approvalDelegation = this.store.getSetting<boolean>('approvalDelegation')
    const quietExceptions = this.store.getSetting<unknown>('quietExceptions')
    return {
      quietHours: parseQuietWindow(this.store.getSetting<unknown>('quietHours')) ?? null,
      quietExceptions: Array.isArray(quietExceptions)
        ? quietExceptions.filter((id): id is string => typeof id === 'string')
        : [],
      workerSlots: typeof workerSlots === 'number' ? workerSlots : 2,
      observeMode: observeMode !== false,
      approvalDelegation: approvalDelegation !== false,
    }
  }

  saveSettings(patch: ResidentSettings): ResidentSettings {
    if (patch.quietHours !== undefined) {
      this.store.setSetting('quietHours', patch.quietHours === null ? null : parseQuietWindow(patch.quietHours) ?? null)
    }
    if (patch.quietExceptions !== undefined) {
      this.store.setSetting(
        'quietExceptions',
        patch.quietExceptions.filter((id) => typeof id === 'string' && id !== ''),
      )
    }
    if (patch.workerSlots !== undefined) {
      const slots = Math.max(0, Math.min(8, Math.trunc(patch.workerSlots)))
      this.store.setSetting('workerSlots', slots)
    }
    if (patch.observeMode !== undefined) this.store.setSetting('observeMode', patch.observeMode === true)
    if (patch.approvalDelegation !== undefined) {
      this.store.setSetting('approvalDelegation', patch.approvalDelegation === true)
    }
    return this.settings()
  }

  // ── workspaces ────────────────────────────────────────────────────────────

  /**
   * Registered dsh workspaces (canonical path records). The resident layer
   * uses the FIRST one as its default binding — new workspaces are prepended
   * by the registry, so that is the user's most recent project.
   */
  listWorkspaces(): WorkspaceInfo[] {
    return this.workspaceCache ?? this.readWorkspacesNow()
  }

  /** One synchronous registry read (empty when the service is absent). */
  private readWorkspacesNow(): WorkspaceInfo[] {
    const registry = this.deps.ctx.get('workspaceRegistry') as
      | { list(): Array<{ id: string; path: string; title: string }> }
      | undefined
    if (registry === undefined) return []
    this.workspaceCache = registry
      .list()
      .map((workspace) => ({ id: String(workspace.id), path: workspace.path, title: workspace.title }))
    return this.workspaceCache
  }

  /**
   * Load the workspace registry once, waiting briefly for its service: the
   * workspace plugin is a web-layer row whose async init can still be pending
   * when this plugin's apply runs.
   */
  private async loadWorkspaces(timeoutMs = 5000): Promise<WorkspaceInfo[]> {
    if (this.workspaceCache !== undefined) return this.workspaceCache
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const immediate = this.readWorkspacesNow()
      if (immediate.length > 0) return immediate
      if (this.deps.ctx.get('workspaceRegistry') !== undefined) return immediate
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    this.workspaceCache = []
    return this.workspaceCache
  }

  /** Resolve a workspace by id, exact path, or title (undefined = default = first). */
  resolveWorkspace(ref?: string): WorkspaceInfo | undefined {
    const all = this.listWorkspaces()
    if (ref === undefined || ref.trim() === '') return all[0]
    const needle = ref.trim()
    const target = normalize(needle).toLowerCase()
    return (
      all.find((workspace) => workspace.id === needle) ??
      all.find((workspace) => workspace.title === needle) ??
      all.find((workspace) => normalize(workspace.path).toLowerCase() === target) ??
      all.find((workspace) => normalize(workspace.path).toLowerCase().startsWith(target))
    )
  }

  // ── delegation surface (butler tools) ─────────────────────────────────────

  sendMessage(input: {
    text: string
    kind: 'text' | 'question' | 'report' | 'system'
    replyTo?: string
  }): { id: string; recorded: boolean } {
    // Butler messages are events, not deduplicable content: the same sentence
    // said twice must produce two bubbles, so the key is per call.
    const outcome = this.ledger.postOutbound({
      kind: input.kind,
      text: input.text,
      idempotencyKey: `butler:${randomUUID()}`,
      ...(input.replyTo !== undefined ? { refs: { replyTo: input.replyTo } } : {}),
    })
    return { id: outcome.message?.id ?? '', recorded: outcome.recorded }
  }

  createSession(input: { goal: string; title?: string; workspace?: string }): CreatedSession {
    const workspace = this.resolveWorkspace(input.workspace)
    if (input.workspace !== undefined && input.workspace.trim() !== '' && workspace === undefined) {
      const known = this.listWorkspaces().map((entry) => `${entry.title}（${entry.path}）`).join('、')
      throw new Error(`unknown workspace "${input.workspace}"；可用工作区：${known === '' ? '无' : known}`)
    }
    const id = `tkt_${randomUUID()}`
    const now = new Date().toISOString()
    const ticket: Ticket = {
      id,
      goal: input.goal,
      mandate: 'explicit',
      origin: 'butler',
      state: 'pending',
      nextRunAt: now,
      ...(workspace !== undefined ? { workspace: workspace.path } : {}),
      createdAt: now,
      updatedAt: now,
    }
    this.store.upsertTicket(ticket)
    return {
      ticketId: id,
      sessionId: `resident-worker-${shortId(id)}`,
      state: 'pending',
      ...(workspace !== undefined ? { workspace: workspace.path } : {}),
    }
  }

  sendToSession(sessionId: string, text: string): { ok: boolean; error?: string } {
    const agent = this.deps.agents.get(brandString(sessionId) as SessionId)
    if (agent === undefined) return { ok: false, error: `worker session ${sessionId} is not live` }
    agent.followup(
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    )
    return { ok: true }
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.listSessions().find((session) => session.sessionId === sessionId)
  }

  listSessions(): SessionInfo[] {
    const tickets = new Map(this.store.listTickets().map((ticket) => [ticket.id, ticket]))
    return this.store.listWorkerSessions().map((worker) => {
      const ticket = tickets.get(worker.ticketId)
      return {
        sessionId: worker.sessionId,
        ticketId: worker.ticketId,
        goal: ticket?.goal ?? '',
        state: ticket?.state ?? worker.state,
        ...(ticket?.workspace !== undefined && ticket.workspace !== null ? { workspace: ticket.workspace } : {}),
        ...(worker.lastReport !== undefined ? { lastReport: worker.lastReport } : {}),
        ...(ticket?.summary !== undefined ? { summary: ticket.summary } : {}),
      }
    })
  }

  cancelSession(sessionId: string): { ok: boolean; error?: string } {
    const worker = this.store.listWorkerSessions().find((row) => row.sessionId === sessionId)
    if (worker === undefined) return { ok: false, error: `unknown worker session ${sessionId}` }
    const ticket = this.store.getTicket(worker.ticketId)
    if (ticket === undefined) return { ok: false, error: `ticket ${worker.ticketId} is missing` }
    if (ticket.state !== 'stopped' && ticket.state !== 'completed') {
      transitionTicket(this.store, ticket, 'stopped', { summary: '已被管家叫停' })
    }
    const agent = this.deps.agents.get(brandString(sessionId) as SessionId)
    agent?.cancel({ kind: 'user' })
    return { ok: true }
  }

  pendingApprovals(): PendingApproval[] {
    return this.approvals?.pendingApprovals() ?? []
  }

  resolveApproval(id: string, approved: boolean): { ok: boolean; error?: string } {
    if (this.approvals === undefined) return { ok: false, error: 'approval broker is not installed' }
    return this.approvals.resolveApproval(id, approved, 'butler')
  }

  // ── turn pump ─────────────────────────────────────────────────────────────

  private async pump(): Promise<void> {
    this.pumping = true
    this.store.upsertButlerState({
      sessionId: this.sessionId,
      state: 'working',
      lastActiveAt: new Date().toISOString(),
    })
    this.restartTimer = undefined
    try {
      // New rows that arrive mid-turn are handled by the next iteration.
      // Bounded by the queue draining; the loop exits as soon as it is empty.
      for (let guard = 0; guard < 50; guard++) {
        const batch = this.ledger.pendingInbound(BATCH_LIMIT)
        if (batch.length === 0) break
        const agent = this.agent
        if (agent === undefined) break
        await this.runTurn(agent, renderInbound(batch))
        this.ledger.consume(batch.map((message) => message.id))
      }
    } catch (error) {
      // A failed turn must not replay forever: the batch stays unconsumed (so
      // the user's words are never lost), the pump retries once after a pause.
      console.error('[hibbuddy-resident] butler turn failed:', error)
      if (!this.stopped) {
        this.restartTimer = setTimeout(() => this.wake(), 15_000)
        this.restartTimer.unref?.()
      }
    } finally {
      this.pumping = false
      if (!this.stopped) {
        this.store.upsertButlerState({
          sessionId: this.sessionId,
          state: 'idle',
          lastActiveAt: new Date().toISOString(),
        })
      }
      this.settleIdle()
    }
  }

  /** Resolves queued `whenIdle` calls once no turn is running and nothing is queued. */
  private settleIdle(): void {
    if (this.pumping || this.store.countPendingInbound() > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const waiter of waiters) waiter()
  }

  private async runTurn(agent: Agent, prompt: string): Promise<void> {
    agent.followup(
      createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }),
    )
    // Quiescence = idle AND no pending subagent children (headless parity).
    while (true) {
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      const childrenPending = await this.deps.ctx.get('subagents')?.waitForChildren(agent)
      if (childrenPending !== true && agent.status === 'idle' && agent.session.seq === idleSeq) break
    }
    await this.deps.ctx.get('sessions')?.flush(agent.session)
  }

  /**
   * The butler's own working directory = its bound workspace root. Binding to
   * a canonical workspace path is what makes the butler session appear under
   * that workspace (dsh validates membership by header cwd). Falls back to the
   * process filesystem root when no workspace record exists.
   */
  private async resolveWorkspaceRoot(): Promise<string> {
    if (this.workspaceRoot !== undefined) return this.workspaceRoot
    const preferred = this.resolveWorkspace(this.preferredWorkspace)
    if (preferred !== undefined) {
      this.workspaceRoot = preferred.path
      return preferred.path
    }
    if (this.preferredWorkspace !== undefined) {
      console.warn(`[hibbuddy-resident] configured workspace "${this.preferredWorkspace}" not found; using the first registered workspace`)
      const first = this.resolveWorkspace()
      if (first !== undefined) {
        this.workspaceRoot = first.path
        return first.path
      }
    }
    const fs = this.deps.ctx.get('fs')
    this.workspaceRoot = fs ? fs.processPath(await fs.resolve('.')) : process.cwd()
    return this.workspaceRoot
  }
}
