/**
 * Resident layer domain model (resident-design.md §3, personal scenario).
 *
 * Kept intentionally small: tickets self-hold their state (never mirroring the
 * worker session), mandates are two ticket fields, and the multi-user research
 * concepts of the prototype (threads/subscriptions/policies) are dropped.
 */

/** Ticket lifecycle (resident-design.md §3.1). */
export type TicketState =
  | 'pending'
  | 'working'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'stopped'

/** Terminal states from which no trigger is ever accepted again. */
const TERMINAL_STATES: ReadonlySet<TicketState> = new Set(['completed', 'stopped'])

/** True once a ticket reached a terminal state. */
export function isTerminal(state: TicketState): boolean {
  return TERMINAL_STATES.has(state)
}

/** Authorization basis on a ticket (design §3, Mandate simplified to two flavors). */
export type Mandate = 'explicit' | 'inferred'

/** Periodic schedule of a ticket; absent for one-shot tickets. */
export interface TicketPeriod {
  /** Fixed interval between runs, in milliseconds. */
  intervalMs: number
}

/** A work item the user only sees as a goal (design §3 Ticket). */
export interface Ticket {
  id: string
  /** The goal the user stated (worker prompt). */
  goal: string
  mandate: Mandate
  /** Where the ticket came from: 'user' or 'monitor:<sourceId>'. */
  origin: string
  state: TicketState
  /** Present for periodic tickets (one row lives forever, runs append to history). */
  period?: TicketPeriod
  /** Next due run (ISO instant); scheduler index. Null when not scheduled. */
  nextRunAt?: string | null
  /** Worker-produced plan, if any. */
  plan?: string
  /** Worker-produced summary of the latest run outcome. */
  summary?: string
  /** Canonical workspace path the worker executes under (ADR-011 delegation). */
  workspace?: string | null
  /** Current worker session id, when one exists. */
  sessionId?: string | null
  /** Set by startup reconciliation when a working ticket could not be resumed. */
  interrupted?: boolean
  createdAt: string
  updatedAt: string
}

/** One execution round of a ticket (design §3 ticket_runs). */
export interface TicketRun {
  id?: number
  ticketId: string
  startedAt: string
  finishedAt?: string | null
  /** ok | failed | awaiting_approval | interrupted — open-ended for B3+ evolution. */
  outcome?: string | null
  detail?: string
}

/** A registered event-source instance (design §3 TriggerSource). */
export interface SourceInstance {
  id: string
  kind: string
  enabled: boolean
  /** Kind-specific configuration (JSON). */
  config: unknown
  /** Read position / last-fire marker; restored on restart so nothing replays. */
  cursor?: unknown
  /** Next scheduled fire (ISO instant); the scheduler's primary index. */
  nextRunAt?: string | null
  /** Set when the source failed repeatedly (design §4.2 monitor backoff). */
  degraded?: boolean
}

/** An immutable event emitted by a source (design §3 Trigger). */
export interface Trigger {
  id: string
  sourceId: string
  at: string
  /** Kind-specific event payload (JSON). */
  payload: unknown
  /** Injection-surface flag, reserved for future external sources (design §11.5). */
  untrusted?: boolean
}

/** Worker-session bookkeeping (design §3 WorkerSession — worker = an ordinary session). */
export interface WorkerSession {
  ticketId: string
  sessionId: string
  /** idle | working | awaiting_approval | blocked. */
  state: string
  lastReport?: string
  /** Written by the store on every upsert; optional on the write side. */
  updatedAt?: string
}

/** Who wrote a message: the user ('in') or the butler ('out'). */
export type MessageDirection = 'in' | 'out'

/**
 * Message kinds (ADR-011 D2/D11). Outbound rows come from the butler's
 * `send_message_to_user` tool except `approval`, which the host writes on
 * `approval/asked`; inbound rows are user text plus event envelopes, worker
 * receipts and approval events.
 */
export type MessageKind =
  | 'text'
  | 'question'
  | 'report'
  | 'system'
  | 'event'
  | 'receipt'
  | 'approval'

/** References a message points at (ticket / worker session / source / reply). */
export interface MessageRefs {
  ticketId?: string | null
  sessionId?: string | null
  sourceId?: string | null
  replyTo?: string | null
}

/**
 * Media kind of an attachment, chosen so the chat panel knows how to preview
 * it (image lightbox, inline video/audio, file card).
 */
export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

/**
 * One file or media item riding on a message (ADR-011 message surface, WeChat
 * parity). A local file (`path`, served by the host through its whitelisted
 * attachment route) and a remote URL (`url`, used directly) are exclusive.
 */
export interface MessageAttachment {
  id: string
  kind: AttachmentKind
  /** Display name (basename or the URL's last segment). */
  name: string
  /** Canonical local path; host serves it via `/resident/api/attachment?id=`. */
  path?: string
  /** Remote http(s) URL; the client renders it directly. */
  url?: string
  /** Resolved MIME type, when known. */
  mime?: string
  /** Byte size for local files. */
  size?: number
}

/**
 * One row of the conversation ledger — the ONLY data source of the chat UI
 * (ADR-011 D2). Persisted before any delivery; `delivered` tracks push.
 */
export interface Message {
  id: string
  direction: MessageDirection
  kind: MessageKind
  /** Optional heading (e.g. "任务完成：…"), the chat bubble itself uses `text`. */
  title?: string
  /** Markdown body; the chat panel renders it as Markdown. */
  text: string
  /** Files/media riding on this message (images, video, audio, documents). */
  attachments?: MessageAttachment[]
  refs?: MessageRefs
  /** Idempotency key; duplicates are dropped by the store. */
  idempotencyKey: string
  read: boolean
  /** Delivery flag; do-not-disturb keeps it false until re-reached. */
  delivered: boolean
  /** Inbound only: set when the butler turn consumed it (queue cursor). */
  consumedAt?: string | null
  createdAt: string
}

/** Butler session bookkeeping (ADR-011 D1). */
export interface ButlerState {
  sessionId: string
  /** idle | working. */
  state: string
  lastActiveAt?: string | null
}

/** Orchestrator settings persisted in SQLite (design §8; panel edits explicitly save/discard). */
export interface ResidentSettings {
  /** Do-not-disturb window (messages persist but do not push). */
  quietHours?: { start: string; end: string } | null
  /** Ticket ids exempt from the do-not-disturb window (design §9). */
  quietExceptions?: string[]
  /** Concurrent worker slots (design §5, default 2). */
  workerSlots?: number
  /** Global observe-mode switch for inferred actions (design §6). */
  observeMode?: boolean
  /** Butler may answer low-risk approvals itself (ADR-011 D9). */
  approvalDelegation?: boolean
}
