/**
 * Shared-state opener seam (S4-6, FR-05): the chat-scoped turn tails need
 * `ctx.sidebarRight.openTab`, but the sidebar service is read lazily from the
 * client root context — the apply body only installs this closure, so the
 * command runs after the service exists. Mirrors canvas-open.ts.
 *
 * Failures degrade to a console warning rather than crashing the React tree:
 * auto-open on a freshly reloaded page may race the sidebar seat mounting.
 */
type SharedStateOpener = () => void

let opener: SharedStateOpener | undefined
/** Sessions this page lifetime has already auto-revealed the panel for. */
const revealed = new Set<string>()

/** Install the openTab closure (apply time). */
export function setSharedStateOpener(next: SharedStateOpener): void {
  opener = next
}

/**
 * Reveal the shared-state tab once per session per page lifetime — the first
 * observed `shared_state` write opens the panel; later writes just update it
 * (the user may have closed the tab on purpose). Degrades to a warning.
 */
export function revealSharedState(sessionId: string): void {
  if (opener === undefined || revealed.has(sessionId)) return
  revealed.add(sessionId)
  try {
    opener()
  } catch (error) {
    console.warn('[hibuddy-genui] shared-state open failed', error)
  }
}
