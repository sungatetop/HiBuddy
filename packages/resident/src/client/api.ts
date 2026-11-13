/**
 * Client data access for the butler chat (same-origin, dsh fence cookie).
 */

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file' | 'ui'

/** One file/media item riding on a chat message (mirrors the host domain type). */
export interface ChatAttachment {
  id: string
  kind: AttachmentKind
  name: string
  path?: string
  url?: string
  mime?: string
  size?: number
}

export interface ChatMessage {
  id: string
  direction: 'in' | 'out'
  kind: string
  title?: string
  /** Markdown body (butler messages render it; user text stays literal). */
  text: string
  attachments?: ChatAttachment[]
  /** Ledger references; `sessionId` makes the bubble link to that worker session. */
  refs?: { ticketId?: string; sessionId?: string; sourceId?: string; replyTo?: string }
  createdAt: string
}

/** Same-origin source for one attachment (remote URLs bypass the host route). */
export function attachmentSrc(attachment: ChatAttachment): string {
  return attachment.url ?? `/resident/api/attachment?id=${encodeURIComponent(attachment.id)}`
}

/** One persisted render_ui instruction (genui-agui-optimization.md G3). */
export interface UiInstruction {
  id: string
  revision: number
  component: string
  props?: unknown
  data?: unknown
  provenance?: string
  summary?: string
  createdAt: string
}

/** Reads one generative-UI instruction by reference (kind='ui' attachment URL). */
export async function fetchUiInstruction(src: string): Promise<UiInstruction> {
  const response = await fetch(src, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`ui-instruction API ${response.status}`)
  return (await response.json()) as UiInstruction
}

export interface ChatSnapshot {
  messages: ChatMessage[]
  /** True when older messages exist beyond this window ("load earlier" affordance). */
  hasMore: boolean
  status: { sessionId: string; state: string; pendingInbound: number; quiet?: boolean }
  unread: number
}

/** Reads the transcript + butler status.
 *
 * Backward cursor paging: omit `before` for the newest window; pass the
 * oldest loaded id to fetch the next page of earlier messages (`limit`
 * window size, host caps at 500).
 */
export async function fetchChat(params?: { limit?: number; before?: string }): Promise<ChatSnapshot> {
  const search = new URLSearchParams()
  if (params?.limit !== undefined) search.set('limit', String(params.limit))
  if (params?.before !== undefined) search.set('before', params.before)
  const query = search.toString()
  const response = await fetch(`/resident/api/messages${query === '' ? '' : `?${query}`}`, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`chat API ${response.status}`)
  return (await response.json()) as ChatSnapshot
}

/** Sends one user message; the transcript poll picks up the reply.
 *
 * Every send carries a fresh `clientId` so the host's idempotency keys on the
 * SEND ACTION, not the content — identical texts (a form re-submitting the
 * same payload) must still record, or the G2 send-back gate never sees the
 * second send (genui-agui-optimization.md G2 E2E finding).
 */
export async function sendChat(text: string): Promise<void> {
  const response = await fetch('/resident/api/messages', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, clientId: crypto.randomUUID() }),
  })
  if (!response.ok) throw new Error(`chat API ${response.status}`)
}

/** Marks the given outbound rows read (the chat marks what it has shown). */
export async function markRead(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const response = await fetch('/resident/api/messages/read', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  if (!response.ok) throw new Error(`read API ${response.status}`)
}

/** One delegated worker session as the drawer lists it. */
export interface SessionInfo {
  sessionId: string
  ticketId: string
  goal: string
  state: string
  workspace?: string
  lastReport?: string
  summary?: string
}

/** One approval waiting for a decision. */
export interface PendingApproval {
  id: string
  ticketId?: string
  sessionId: string
  toolName: string
  reason: string
  requiresUser: boolean
  createdAt: string
}

export interface SessionsSnapshot {
  sessions: SessionInfo[]
  approvals: PendingApproval[]
}

/** Panel-editable resident settings (explicit save). */
export interface ResidentSettings {
  quietHours: { start: string; end: string } | null
  quietExceptions: string[]
  workerSlots: number
  observeMode: boolean
  approvalDelegation: boolean
}

export async function fetchSessions(): Promise<SessionsSnapshot> {
  const response = await fetch('/resident/api/sessions', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`sessions API ${response.status}`)
  return (await response.json()) as SessionsSnapshot
}

export async function fetchSettings(): Promise<ResidentSettings> {
  const response = await fetch('/resident/api/settings', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`settings API ${response.status}`)
  return (await response.json()) as ResidentSettings
}

export async function saveSettings(patch: Partial<ResidentSettings>): Promise<ResidentSettings> {
  const response = await fetch('/resident/api/settings', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch }),
  })
  if (!response.ok) throw new Error(`settings API ${response.status}`)
  return (await response.json()) as ResidentSettings
}
