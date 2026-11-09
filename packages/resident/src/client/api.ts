/**
 * Client data access for the butler chat (same-origin, dsh fence cookie).
 */

export interface ChatMessage {
  id: string
  direction: 'in' | 'out'
  kind: string
  title?: string
  text: string
  createdAt: string
}

export interface ChatSnapshot {
  messages: ChatMessage[]
  status: { sessionId: string; state: string; pendingInbound: number }
  unread: number
}

/** Reads the transcript + butler status. */
export async function fetchChat(): Promise<ChatSnapshot> {
  const response = await fetch('/resident/api/messages', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`chat API ${response.status}`)
  return (await response.json()) as ChatSnapshot
}

/** Sends one user message; the transcript poll picks up the reply. */
export async function sendChat(text: string): Promise<void> {
  const response = await fetch('/resident/api/messages', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) throw new Error(`chat API ${response.status}`)
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
