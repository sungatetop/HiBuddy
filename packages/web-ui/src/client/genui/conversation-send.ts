/**
 * Conversation send-back seam (ADR-007 §3.4): the ONE channel from generative-UI
 * surfaces back into the session. `apply` installs the sender (it needs root
 * services); surface components call `sendGenuiText(sessionId, text)` — dispatch
 * failures degrade to a console warning, never breaking the React tree (the
 * caller still learns success through the boolean return).
 */
import type { RenderUiInstruction } from './instruction.ts'

/** Session-addressed prompt sender (installed once at apply time). */
export type SessionSender = (sessionId: string, text: string) => Promise<void>

let sender: SessionSender | undefined

/** Install the session sender; later calls replace earlier ones (apply is idempotent). */
export function setConversationSender(install: SessionSender): void {
  sender = install
}

/**
 * Send one structured interaction text into the session as a queued turn.
 * @returns whether the send was dispatched (false = seam unwired, no session, or empty text).
 */
export function sendGenuiText(sessionId: string | undefined, text: string): boolean {
  if (sender === undefined || sessionId === undefined || text.trim() === '') return false
  void sender(sessionId, text).catch((error: unknown) => {
    console.warn('hibuddy-web-ui: generative-UI send-back failed', error)
  })
  return true
}

/** One generative-UI interaction sent back to the model. */
export interface GenuiInteraction {
  /** Component key that produced the event (e.g. `form`). */
  readonly component: string
  /** Interaction kind (e.g. `submit`). */
  readonly interaction: string
  /** JSON payload of the interaction (form values, click targets, …). */
  readonly payload: unknown
}

/**
 * Wrap one interaction into the structured text the model reads next turn
 * (G2 contract, genui-agui-optimization.md): one line, `@[ui:<id>:<revision>]`
 * followed by one JSON object {component, event, payload}. The revision lets
 * the host reject stale surfaces' submissions (the butler pump compares it to
 * the latest registered revision); surfaces older than the latest revision
 * render read-only client-side, so this is the belt over the suspenders.
 */
export function formatGenuiInteraction(instruction: RenderUiInstruction, event: GenuiInteraction): string {
  const payload = safeJson({ component: event.component, event: event.interaction, payload: event.payload })
  if (instruction.id === undefined) {
    // Defensive: ready surfaces always carry an id (instructionReady gates
    // rendering); the legacy multi-line envelope keeps such a stray readable.
    return [
      '[generative-ui interaction]',
      `surface: (inline)`,
      `component: ${event.component}`,
      `interaction: ${event.interaction}`,
      `payload: ${payload}`,
    ].join('\n')
  }
  return `@[ui:${instruction.id}:${instruction.revision ?? 1}] ${payload}`
}

/** JSON-encode a payload that is already closed JSON data. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '"(unserializable)"'
  }
}
