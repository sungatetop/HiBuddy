/**
 * Generative-UI trusted-component registry (ADR-007 §3.3).
 *
 * The client renders model instructions exclusively through compiled-in,
 * trusted React components looked up here: the model names a component key
 * and supplies props/data, it can never introduce code (SR-02 — the rendering
 * surface is data projection, not an execution sandbox for model output).
 * P0 ships four built-ins (chart/form/table/metrics, S4-3); unknown keys and
 * failed renders degrade to a static view (see `render-ui-card.tsx`).
 */
import type { ComponentType } from 'react'
import type { GenuiLocaleKey } from './locales.ts'
import type { RenderUiInstruction, UiComponentKey } from './instruction.ts'

/** Translate bound to the `hibuddy-genui` namespace (card registration face). */
export type SurfaceTranslate = (key: GenuiLocaleKey) => string

/** Props every trusted surface component receives at render time. */
export interface UiSurfaceProps {
  /** The parsed instruction; `props`/`data` are closed JSON values here. */
  instruction: RenderUiInstruction
  /** Namespace translate for the surface's own copy. */
  t: SurfaceTranslate
  /** Current session id (session standard props), enabling the send-back seam. */
  sessionId?: string
}

/** A registry surface component. */
export type UiSurface = ComponentType<UiSurfaceProps>

const surfaces = new Map<UiComponentKey, UiSurface>()

/** Register (or replace) the renderer for one component key. */
export function registerUiSurface(key: UiComponentKey, surface: UiSurface): void {
  surfaces.set(key, surface)
}

/** Look up the renderer for one key; undefined when the model named an unknown key. */
export function uiSurfaceOf(key: UiComponentKey): UiSurface | undefined {
  return surfaces.get(key)
}
