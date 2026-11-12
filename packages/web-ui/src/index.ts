/**
 * HiBuddy web-UI customization plugin — node half.
 *
 * S4 (ADR-007): registers the `render_ui` tool — the model's only output
 * channel for generative UI. Component instructions, not frontend code: the
 * no-op body just confirms acceptance, and the browser half renders the
 * instruction with trusted components via the `tool.call.toolview` keyed
 * slot (inline) and the sidebar-right canvas tab (persistent surfaces).
 *
 * S4-6 (FR-05): registers the `shared_state` tool — the agent half of the
 * run-level shared task state; the browser panel edits the same keys and its
 * edits arrive back as `[shared-state update]` turns the model relays here.
 *
 * S5-1 (FR-06): mounts the `hibuddy` Typert remote service — the host-side
 * provider connectivity probe behind the Models-page connection-check card.
 */

import type { Context } from '@deepseek-ai/cordis'
import { RevisionRegistry } from './genui-schema.ts'
import { createRenderUiTool } from './render-ui-tool.ts'
import { createSharedStateTool } from './shared-state-tool.ts'
import { SharedStateStore } from './shared-state.ts'
import { HibuddyVerifyService } from './verify-provider.ts'

/**
 * Cross-package exports (consumed by @hibuddy/resident's butler tool face,
 * genui-agui-optimization.md G4): the shared parameter schema/description plus
 * the host-side shape gate — the butler face re-declares render_ui with the
 * same contract and adds ledger persistence + announcement.
 */
export { assertPlainArrays, RENDER_UI_DESCRIPTION, RENDER_UI_PARAMETERS } from './render-ui-tool.ts'

/** Cordis function-plugin name. */
export const name = 'hibuddy-web-ui'

/** Required host services. */
export const inject = ['tools', 'llm']

/**
 * Cordis service name of the instruction revision registry (genui-schema G2):
 * provided here, read lazily (non-strict) by the resident butler pump to
 * reject stale `@[ui:…]` send-backs before they reach the model.
 */
export const GENUI_REVISIONS_SERVICE = 'hibuddy-genui-revisions'

/** Register the generative-UI instruction tool and the shared-state tool. */
export function apply(ctx: Context): void {
  // Session-scoped instruction revision registry (G1/G2): render_ui.execute
  // records id → latest revision; the butler pump consumes the same registry
  // through the cordis service below. Disposed sessions drop their entries.
  const revisions = new RevisionRegistry()
  ctx.provide(GENUI_REVISIONS_SERVICE, revisions)
  ctx.on('session/disposed', (session) => {
    revisions.dropSession(session.id)
  })
  ctx.tools.register(createRenderUiTool(revisions))
  // Session-scoped, in-memory shared state: the durable trail stays in the
  // native tool/call + tool/result session events (FR-08); disposal drops it.
  const sharedState = new SharedStateStore()
  ctx.tools.register(createSharedStateTool(sharedState))
  ctx.on('session/disposed', (session) => {
    sharedState.dropSession(session.id)
  })
  // Typert remote service: registers under the `hibuddy` key and binds the
  // same wire namespace into the gateway (constructor does both); the `llm`
  // face is captured here — remote callbacks run outside this scope.
  new HibuddyVerifyService(ctx, ctx.llm)
}
