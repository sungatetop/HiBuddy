/**
 * Canvas opener seam (ADR-007 §3.3): the flow-scoped cards (toolview and
 * turn-tail mirror) and the turn-tail recorder need `ctx.sidebarRight.openTab`,
 * but the sidebar service is read lazily from the client root context — the
 * apply body only installs this closure, so the command runs after the service
 * exists.
 *
 * Failures degrade to a console warning rather than crashing the React tree:
 * auto-open on a freshly reloaded page may race the sidebar seat mounting.
 */
type CanvasOpener = (canvasId: string) => void

let opener: CanvasOpener | undefined

/** Install the openTab closure (apply time). */
export function setCanvasOpener(next: CanvasOpener): void {
  opener = next
}

/** Reveal the canvas tab switched to `canvasId`; degrades to a warning. */
export function openGenuiCanvas(canvasId: string): void {
  if (opener === undefined) return
  try {
    opener(canvasId)
  } catch (error) {
    console.warn('[hibuddy-genui] canvas open failed', error)
  }
}
