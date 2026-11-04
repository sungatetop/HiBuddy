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
 */

import type { Context } from '@deepseek-ai/cordis'
import { renderUiTool } from './render-ui-tool.ts'
import { createSharedStateTool } from './shared-state-tool.ts'
import { SharedStateStore } from './shared-state.ts'

/** Cordis function-plugin name. */
export const name = 'hibuddy-web-ui'

/** Required host services. */
export const inject = ['tools']

/** Register the generative-UI instruction tool and the shared-state tool. */
export function apply(ctx: Context): void {
  ctx.tools.register(renderUiTool)
  // Session-scoped, in-memory shared state: the durable trail stays in the
  // native tool/call + tool/result session events (FR-08); disposal drops it.
  const sharedState = new SharedStateStore()
  ctx.tools.register(createSharedStateTool(sharedState))
  ctx.on('session/disposed', (session) => {
    sharedState.dropSession(session.id)
  })
}
