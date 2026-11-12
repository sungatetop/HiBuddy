/**
 * Embeddable generative-UI face (genui-agui-optimization.md G4): the four
 * trusted surfaces + the component registry + the send-back seam, for client
 * bundles that render ledger UI references OUTSIDE the dsh conversation view
 * (the resident butler chat panel). No @deepseek-ai runtime import — only
 * type-only ones, erased at build — so any bundler can inline this entry.
 *
 * The embedder wires two seams itself: `registerGenuiSurfaces()` fills the
 * registry (idempotent), and `setConversationSender` routes surface events
 * back (the chat panel posts the structured `@[ui:…]` text through its own
 * message channel, so the host's G2 revision gate sees it identically).
 */
export { ChartSurface } from './client/genui/chart.tsx'
export { FormSurface } from './client/genui/form.tsx'
export { MetricsSurface } from './client/genui/metrics.tsx'
export { TableSurface } from './client/genui/table.tsx'
export {
  registerUiSurface,
  uiSurfaceOf,
  type SurfaceTranslate,
  type UiSurfaceProps,
} from './client/genui/registry.ts'
export { registerGenuiSurfaces } from './client/genui/surfaces.ts'
export { setConversationSender } from './client/genui/conversation-send.ts'
export { setSubmitButton, type SubmitButtonComponent } from './client/genui/submit-button.tsx'
export { GenuiSkin, accentStyle, componentAccent } from './client/genui/skin.tsx'
export type { RenderUiInstruction } from './client/genui/instruction.ts'
export { en, zh, type GenuiLocaleKey } from './client/genui/locales.ts'
