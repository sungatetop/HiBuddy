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
import {
  evaluateUiSendBack,
  normalizeRevision,
  type RevisionRegistry,
} from '@hibuddy/web-ui/genui-schema'
import type { ApprovalBrokerFace, PendingApproval } from './approvals.ts'
import { prepareAttachments, type AttachmentRequest } from './attachments.ts'
import {
  CHANNEL_IDS,
  CHANNEL_SESSION_PREFIXES,
  discoverDingtalkSessions,
  parseChannelConfig,
  type ChannelConfig,
  type ChannelId,
  type ChannelSourceInfo,
} from './channel.ts'
import type {
  ApprovalData,
  EventData,
  Message,
  MessageAttachment,
  ReceiptData,
  ResidentSettings,
  Ticket,
  UiInstruction,
} from './domain.ts'
import { parseQuietWindow, type MessageService } from './messages.ts'
import { renderSituation } from './situation.ts'
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

/** One render_ui instruction the butler face accepted (G4; args as the tool received them). */
export interface RenderedUiInstruction {
  id: string
  revision?: number
  target?: string
  component: string
  props?: unknown
  data?: unknown
  provenance?: string
  summary: string
}

/**
 * The service the butler tools consume (provided on the root context as
 * `resident`; the tools plugin mounts inside the preset's agent scope).
 */
export interface ResidentButler {
  readonly sessionId: string
  /**
   * User text from the chat UI; records the inbound row and wakes the pump.
   * `clientId` makes the send idempotent per SEND ACTION, not per content
   * (genui-agui-optimization.md G2 E2E finding): two submits of the same form
   * payload are byte-identical texts, and the content-fingerprint default
   * would silently swallow the second before the send-back gate ever saw it.
   */
  postUserMessage(text: string, clientId?: string): void
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
    /** Worker session this message talks about; the chat links it for one-click open. */
    sessionId?: string
    /** Local workspace files or http(s) URLs to ride on the message. */
    attachments?: AttachmentRequest[]
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
  messages(limit?: number, beforeId?: string): { messages: Message[]; hasMore: boolean }
  /** One attachment row by id (the host's file-serving route). */
  attachment(id: string): (MessageAttachment & { messageId: string }) | undefined
  /** One persisted generative-UI instruction by id (latest, or a given revision). */
  uiInstruction(id: string, revision?: number): UiInstruction | undefined
  /**
   * The generative-UI revision registry (G2 gate / render_ui registration), or
   * undefined when the web-ui plugin is absent (headless compositions).
   */
  genuiRevisions(): RevisionRegistry | undefined
  /**
   * Persists one butler-face render_ui instruction and announces it in the
   * ledger as a kind='ui' attachment reference (G4). Same (id, revision)
   * re-emit is deduplicated by the idempotency key.
   */
  renderUi(instruction: RenderedUiInstruction): {
    id: string
    revision: number
    messageId: string
    recorded: boolean
  }
  unreadCount(): number
  /** Observe outbound rows (butler messages + approval cards) as they are recorded. */
  onOutbound(listener: (message: Message) => void): () => void
  /** Resolves once the current turn (if any) finished and the inbound queue is empty. */
  whenIdle(): Promise<void>
  /** Current panel-editable settings (design §8, explicit save). */
  settings(): ResidentSettings
  /** Persists a settings patch and returns the resulting snapshot. */
  saveSettings(patch: ResidentSettings): ResidentSettings
  /** Live status for the chat UI ("处理中"). `quiet` reflects do-not-disturb. */
  status(): { sessionId: string; state: string; pendingInbound: number; quiet: boolean }
  /** Marks outbound rows read: a set of ids, or everything up to `upTo`. */
  markRead(input: { upTo?: string; ids?: string[] }): number
  // ── channel subscriptions (channel-message-source-design.md v3) ──────────
  /** All channel subscriptions (id/channel/session/enabled/condition). */
  listChannelSources(): ChannelSourceInfo[]
  /** Adds a subscription; without sessionId the plugin's session is discovered by id prefix. */
  addChannelSource(input: {
    channel: ChannelId
    sessionId?: string
    name?: string
    condition?: string
  }): { ok: boolean; sourceId?: string; error?: string }
  /** Removes a subscription row entirely (its cursor dies with it). */
  removeChannelSource(sourceId: string): { ok: boolean; error?: string }
  /** Enables/disables a subscription without losing its cursor. */
  setChannelSourceEnabled(sourceId: string, enabled: boolean): { ok: boolean; error?: string }
}

/** Inbound envelope body cap (perception B12′ §5.1). */
const ROW_BODY_MAX = 1200

/** Relative age of an ISO instant against `now` (刚刚 / N分钟前 / N小时前 / N天前). */
function ageLabel(createdAt: string, now: Date): string {
  const ageMs = now.getTime() - new Date(createdAt).getTime()
  if (!Number.isFinite(ageMs) || ageMs < 0) return '刚刚'
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  return `${Math.floor(hours / 24)}天前`
}

/** Compact duration for the receipt header (48s / 2分05s / 1小时3分). */
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}小时${m % 60}分`
}

/** Compact byte size for the artifact line (12KB / 3KB / 1.2MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Cuts a body to the envelope cap, marking truncation. */
function clip(text: string, max = ROW_BODY_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * One framed inbound row (perception B12′ §5.1): a fixed header carrying the
 * relative age plus whatever structured references/metadata exist, then the
 * title line, artifact line and the body (capped). Old rows without `data`
 * still render age and refs — an immediate fix with no schema migration.
 */
function renderEnvelopeRow(message: Message, now: Date): string {
  const age = ageLabel(message.createdAt, now)
  const refs = message.refs
  switch (message.kind) {
    case 'text': {
      return `【用户｜${age}】\n${clip(message.text)}`
    }
    case 'receipt': {
      const data = message.data as ReceiptData | undefined
      const head: string[] = ['任务回执', age]
      if (refs?.ticketId) head.push(`ticket=${refs.ticketId}`)
      if (refs?.sessionId) head.push(`session=${refs.sessionId}`)
      if (data) {
        head.push(`run=${data.runId}`, formatDuration(data.durationMs), data.outcome)
        if (data.late) head.push('late')
        if (data.recovery) head.push('recovery')
      }
      const lines: string[] = [`【${head.join('｜')}】`]
      if (message.title) lines.push(`（标题）${message.title}`)
      if (data && data.artifacts.length > 0) {
        lines.push(
          `（产出）${data.artifacts
            .slice(0, 20)
            .map((artifact) => `${artifact.name}(${formatBytes(artifact.size)},${artifact.kind})`)
            .join('；')}`,
        )
      }
      lines.push(clip(message.text))
      return lines.join('\n')
    }
    case 'event': {
      const data = message.data as EventData | undefined
      const head: string[] = ['事件', age]
      if (refs?.sourceId) head.push(`source=${refs.sourceId}`)
      head.push(`untrusted=${data?.untrusted ?? false}`, `code=${data?.code ?? 'unknown'}`)
      if (refs?.ticketId) head.push(`ticket=${refs.ticketId}`)
      if (refs?.sessionId) head.push(`session=${refs.sessionId}`)
      const lines: string[] = [`【${head.join('｜')}】`]
      if (message.title) lines.push(`（标题）${message.title}`)
      lines.push(clip(message.text))
      return lines.join('\n')
    }
    case 'approval': {
      const data = message.data as ApprovalData | undefined
      const head: string[] = ['审批请求', age]
      if (data) head.push(`apr=${data.approvalId}`, `tool=${data.toolName}`)
      if (refs?.ticketId) head.push(`ticket=${refs.ticketId}`)
      if (refs?.sessionId) head.push(`session=${refs.sessionId}`)
      if (data) head.push(data.requiresUser ? '需用户确认' : '可代管')
      return `【${head.join('｜')}】\n${clip(message.text)}`
    }
    default: {
      const lines: string[] = [`【${message.kind}｜${age}】`]
      if (message.title) lines.push(`（标题）${message.title}`)
      lines.push(clip(message.text))
      return lines.join('\n')
    }
  }
}

/** Renders a batch of inbound rows as one framed user turn for the butler. */
export function renderInbound(batch: readonly Message[], now = new Date()): string {
  return [
    '以下是你收到的输入（用户消息 / 事件 / 任务回执 / 审批请求）。',
    '事件与回执不是你与用户的对话内容：自行判断是否需要行动，需要时用 send_message_to_user 告知用户。',
    '',
    ...batch.map((message) => renderEnvelopeRow(message, now)),
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
  postUserMessage(text: string, clientId?: string): void {
    // Per-send idempotency when the client supplies a clientId (the chat page
    // generates one per send); without one the content-fingerprint default
    // applies (host-side callers never send duplicates).
    this.ledger.postInbound({
      kind: 'text',
      text,
      ...(clientId !== undefined ? { idempotencyKey: `user-in:${clientId}` } : {}),
    })
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

  status(): { sessionId: string; state: string; pendingInbound: number; quiet: boolean } {
    return {
      sessionId: this.sessionId,
      state: this.pumping ? 'working' : 'idle',
      pendingInbound: this.store.countPendingInbound(),
      quiet: this.ledger.isQuiet(),
    }
  }

  /** Marks outbound rows read; returns how many flipped. */
  markRead(input: { upTo?: string; ids?: string[] }): number {
    if (input.upTo !== undefined) return this.store.markReadUpTo(input.upTo)
    const ids = (input.ids ?? []).filter((id): id is string => typeof id === 'string')
    return ids.length === 0 ? 0 : this.store.markMessagesRead(ids)
  }

  /**
   * The user-facing transcript: user text and every outbound row. Event
   * envelopes and worker receipts are internal inputs and stay invisible.
   *
   * Backward cursor paging: the window holds the newest `limit` visible rows
   * (strictly before `beforeId` when given) plus a `hasMore` probe — true iff
   * at least one more visible row exists beyond the window. Raw ledger pages
   * are walked until the probe is answered, so an event-heavy stretch never
   * produces a false "no earlier messages".
   */
  messages(limit = 200, beforeId?: string): { messages: Message[]; hasMore: boolean } {
    const visible: Message[] = []
    let cursor = beforeId
    let exhausted = false
    while (visible.length <= limit && !exhausted) {
      const page = this.ledger.list({ oldestFirst: false, limit: 400, beforeId: cursor })
      if (page.length < 400) exhausted = true
      // The page is newest-first: continue from its oldest row so pages
      // never overlap.
      if (page.length > 0) cursor = page[page.length - 1]!.id
      for (const message of page) {
        if (message.direction === 'out' || message.kind === 'text') visible.push(message)
      }
    }
    // Newest-first walk; reverse into the chat's oldest-first order.
    const hasMore = visible.length > limit
    return { messages: visible.slice(0, limit).reverse(), hasMore }
  }

  attachment(id: string): (MessageAttachment & { messageId: string }) | undefined {
    return this.store.getAttachment(id)
  }

  uiInstruction(id: string, revision?: number): UiInstruction | undefined {
    return this.store.getUiInstruction(id, revision)
  }

  genuiRevisions(): RevisionRegistry | undefined {
    return this.revisionRegistry()
  }

  renderUi(instruction: RenderedUiInstruction): {
    id: string
    revision: number
    messageId: string
    recorded: boolean
  } {
    const revision = normalizeRevision(instruction.revision)
    const now = new Date().toISOString()
    this.store.saveUiInstruction({
      id: instruction.id,
      revision,
      component: instruction.component,
      ...(instruction.props !== undefined ? { props: instruction.props } : {}),
      ...(instruction.data !== undefined ? { data: instruction.data } : {}),
      ...(instruction.provenance !== undefined ? { provenance: instruction.provenance } : {}),
      summary: instruction.summary,
      sessionId: this.sessionId,
      createdAt: now,
    })
    // Same registration the regular-session render_ui face performs (G1/G2):
    // the butler pump's send-back gate reads it, with the store as fallback.
    this.revisionRegistry()?.record(this.sessionId, instruction.id, revision)
    // Ledger announcement (G4): reference only, never the inline JSON. The
    // attachment carries the ui-instruction URL as its remote `url`, so the
    // existing AG-UI attachment→Markdown mechanism emits
    // [summary](/resident/api/ui-instruction?id=…&revision=…) unchanged, and
    // the chat bubble renders kind='ui' inline via the trusted registry.
    const outcome = this.ledger.postOutbound({
      kind: 'text',
      text: instruction.summary,
      attachments: [
        {
          id: `att_${randomUUID()}`,
          kind: 'ui',
          name: instruction.summary,
          url: `/resident/api/ui-instruction?id=${encodeURIComponent(instruction.id)}&revision=${revision}`,
        },
      ],
      idempotencyKey: `ui:${instruction.id}:${revision}`,
    })
    return { id: instruction.id, revision, messageId: outcome.message?.id ?? '', recorded: outcome.recorded }
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
    const perceptionEvents = this.store.getSetting<boolean>('perceptionEvents')
    const stallMinutes = this.store.getSetting<number>('stallMinutes')
    const reminderMinutes = this.store.getSetting<number>('reminderMinutes')
    return {
      quietHours: parseQuietWindow(this.store.getSetting<unknown>('quietHours')) ?? null,
      quietExceptions: Array.isArray(quietExceptions)
        ? quietExceptions.filter((id): id is string => typeof id === 'string')
        : [],
      workerSlots: typeof workerSlots === 'number' ? workerSlots : 2,
      observeMode: observeMode !== false,
      approvalDelegation: approvalDelegation !== false,
      perceptionEvents: perceptionEvents !== false,
      stallMinutes: typeof stallMinutes === 'number' && stallMinutes >= 1 ? Math.floor(stallMinutes) : 10,
      reminderMinutes: typeof reminderMinutes === 'number' && reminderMinutes >= 1 ? Math.floor(reminderMinutes) : 30,
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
    if (patch.perceptionEvents !== undefined) {
      this.store.setSetting('perceptionEvents', patch.perceptionEvents === true)
    }
    if (patch.stallMinutes !== undefined) {
      const minutes = Math.max(1, Math.min(120, Math.trunc(patch.stallMinutes)))
      this.store.setSetting('stallMinutes', minutes)
    }
    if (patch.reminderMinutes !== undefined) {
      const minutes = Math.max(1, Math.min(1440, Math.trunc(patch.reminderMinutes)))
      this.store.setSetting('reminderMinutes', minutes)
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
    sessionId?: string
    attachments?: AttachmentRequest[]
  }): { id: string; recorded: boolean } {
    // Local attachments are limited to registered workspace roots: that is
    // where workers write, and it keeps a prompt-injected worker from turning
    // the butler into an arbitrary-file reader.
    const attachments = prepareAttachments(
      input.attachments,
      this.listWorkspaces().map((workspace) => workspace.path),
    )
    const refs: NonNullable<Message['refs']> = {}
    if (input.replyTo !== undefined) refs.replyTo = input.replyTo
    if (input.sessionId !== undefined && input.sessionId.trim() !== '') refs.sessionId = input.sessionId.trim()
    // Butler messages are events, not deduplicable content: the same sentence
    // said twice must produce two bubbles, so the key is per call.
    const outcome = this.ledger.postOutbound({
      kind: input.kind,
      text: input.text,
      ...(attachments.length > 0 ? { attachments } : {}),
      idempotencyKey: `butler:${randomUUID()}`,
      ...(Object.keys(refs).length > 0 ? { refs } : {}),
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

  // ── channel subscriptions (channel-message-source-design.md v3) ───────────

  listChannelSources(): ChannelSourceInfo[] {
    return this.store
      .listSources()
      .filter((source) => source.kind === 'channel')
      .map((source) => {
        const config = parseChannelConfig(source.config)
        return {
          id: source.id,
          enabled: source.enabled,
          channel: config?.channel ?? ('wechat' as ChannelId),
          sessionId: config?.sessionId ?? '',
          ...(config?.name !== undefined ? { name: config.name } : {}),
          ...(config?.condition !== undefined ? { condition: config.condition } : {}),
        }
      })
  }

  addChannelSource(input: {
    channel: ChannelId
    sessionId?: string
    name?: string
    condition?: string
  }): { ok: boolean; sourceId?: string; error?: string } {
    if (!CHANNEL_IDS.includes(input.channel)) return { ok: false, error: `未知渠道 ${input.channel}` }
    let sessionId = input.sessionId?.trim()
    if (sessionId === undefined || sessionId === '') {
      const candidates = this.discoverChannelSession(input.channel)
      if (candidates.length === 1) sessionId = candidates[0]
      else if (candidates.length > 1) {
        return {
          ok: false,
          error:
            `该渠道发现 ${candidates.length} 个候选会话：${candidates.join('、')}。` +
            '请确认要订阅哪一个，显式提供 session_id 后重试。',
        }
      }
    }
    if (sessionId === undefined || sessionId === '') {
      return {
        ok: false,
        error:
          '无法定位渠道会话：先在渠道里发一条消息让插件建会话（钉钉则需先完成过一次对话以写入绑定），或显式提供 session_id。',
      }
    }
    if (this.listChannelSources().some((source) => source.sessionId === sessionId)) {
      return { ok: false, error: `该渠道会话已在订阅中（session ${sessionId}）。` }
    }
    const config: ChannelConfig = { channel: input.channel, sessionId }
    if (input.name !== undefined && input.name.trim() !== '') config.name = input.name.trim()
    if (input.condition !== undefined && input.condition.trim() !== '') config.condition = input.condition.trim()
    const id = `src_${randomUUID()}`
    this.store.upsertSource({ id, kind: 'channel', enabled: true, config })
    // No cursor: the bridge's next sweep records the baseline — subscribing
    // never replays the chat history (design v3 first-scan rule).
    return { ok: true, sourceId: id }
  }

  removeChannelSource(sourceId: string): { ok: boolean; error?: string } {
    const source = this.store.getSource(sourceId)
    if (source === undefined || source.kind !== 'channel') {
      return { ok: false, error: `未找到渠道订阅 ${sourceId}` }
    }
    this.store.deleteSource(sourceId)
    return { ok: true }
  }

  setChannelSourceEnabled(sourceId: string, enabled: boolean): { ok: boolean; error?: string } {
    const source = this.store.getSource(sourceId)
    if (source === undefined || source.kind !== 'channel') {
      return { ok: false, error: `未找到渠道订阅 ${sourceId}` }
    }
    this.store.upsertSource({ ...source, enabled })
    return { ok: true }
  }

  /**
   * Candidates for the channel plugin's agent session. Prefixed channels
   * scan live sessions by id prefix (creation order — the last is the most
   * recently created chat). dingtalk has no prefix: its sessions come from
   * the plugin's persisted bindings stores (discoverDingtalkSessions), which
   * works even when the session is not live.
   */
  private discoverChannelSession(channel: ChannelId): string[] {
    if (channel === 'dingtalk') return discoverDingtalkSessions()
    const prefix = CHANNEL_SESSION_PREFIXES[channel]
    if (prefix === undefined) return []
    const sessions = this.deps.ctx.get('sessions') as { list(): Array<{ id: unknown }> } | undefined
    if (sessions === undefined) return []
    return sessions
      .list()
      .map((session) => String(session.id))
      .filter((id) => id.startsWith(prefix))
  }

  resolveApproval(id: string, approved: boolean): { ok: boolean; error?: string } {
    if (this.approvals === undefined) return { ok: false, error: 'approval broker is not installed' }
    return this.approvals.resolveApproval(id, approved, 'butler')
  }

  // ── turn pump ─────────────────────────────────────────────────────────────

  /**
   * The instruction revision registry provided by @hibuddy/web-ui (cordis
   * service `hibuddy-genui-revisions`, G2 send-back gate). Optional: the
   * web-ui plugin may be absent (headless compositions) or not yet applied.
   */
  private revisionRegistry(): RevisionRegistry | undefined {
    return this.deps.ctx.get('hibuddy-genui-revisions') as RevisionRegistry | undefined
  }

  /**
   * UI send-back gate (genui-agui-optimization.md G2): inbound rows shaped
   * `@[ui:<id>:<revision>] {…}` must match the latest revision registered by
   * `render_ui` for that id in this session — stale, unknown, future, or
   * malformed ones are rejected WITHOUT reaching the model (防旧面板误操作 /
   * 伪造回传), and the user gets a visible notice instead. Everything else
   * passes through untouched.
   */
  private gateUiSendBacks(batch: readonly Message[]): Message[] {
    const registry = this.revisionRegistry()
    const deliverable: Message[] = []
    const rejected: Array<{ id: string; stale: boolean }> = []
    for (const message of batch) {
      if (message.kind !== 'text') {
        deliverable.push(message)
        continue
      }
      const verdict = evaluateUiSendBack(message.text, (uiId) =>
        // Memory registry first (live render_ui calls), persisted instructions
        // as the fallback (G3, 开放问题 #2): after a restart the registry is
        // empty and the store keeps the gate closed instead of fail-closed-
        // unknown for every previously rendered surface.
        registry?.latest(this.sessionId, uiId) ?? this.store.latestUiInstructionRevision(uiId))
      if (verdict.action === 'deliver') {
        deliverable.push(message)
      } else {
        rejected.push({ id: message.id, stale: verdict.reason !== 'malformed' })
      }
    }
    for (const { id, stale } of rejected) {
      this.ledger.postOutbound({
        kind: 'system',
        text: stale ? '该界面已更新或已不存在，刚才的操作未生效。' : '界面回传格式无效，操作未生效。',
        idempotencyKey: `ui-reject:${id}`,
      })
    }
    return deliverable
  }

  private async pump(): Promise<void> {
    this.pumping = true
    this.store.upsertButlerState({
      sessionId: this.sessionId,
      state: 'working',
      lastActiveAt: new Date().toISOString(),
    })
    this.restartTimer = undefined
    try {
      // Resolve the bound workspace once per pump (may await the registry);
      // the batch and its situation snapshot below stay free of awaits so the
      // snapshot is the start-of-turn fact matching the batch.
      const workspace = this.workspaceRoot ?? (await this.resolveWorkspaceRoot())
      // New rows that arrive mid-turn are handled by the next iteration.
      // Bounded by the queue draining; the loop exits as soon as it is empty.
      for (let guard = 0; guard < 50; guard++) {
        const batch = this.ledger.pendingInbound(BATCH_LIMIT)
        if (batch.length === 0) break
        const agent = this.agent
        if (agent === undefined) break
        // UI send-back gate (G2) first: rejected rows never enter the turn.
        const deliverable = this.gateUiSendBacks(batch)
        if (deliverable.length === 0) {
          this.ledger.consume(batch.map((message) => message.id))
          continue
        }
        const now = new Date()
        // Deterministic context (perception B12′ §5.2 / §6): a fresh situation
        // snapshot first, then the framed inbound envelope, then — when more
        // rows are still queued behind this batch — the backlog hint.
        const situation = renderSituation(this.store, {
          now,
          workspace,
          pendingApprovals: this.pendingApprovals(),
        })
        const remaining = this.store.countPendingInbound() - batch.length
        const backlog =
          remaining > 0 ? `\n（还有 ${remaining} 条待处理：先处理完当前批，可继续跟进，不必逐条汇报。）` : ''
        await this.runTurn(agent, `${situation}\n\n${renderInbound(deliverable, now)}${backlog}`)
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
