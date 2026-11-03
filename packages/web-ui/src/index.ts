/**
 * HiBuddy web-UI customization plugin — node half.
 *
 * S4 (ADR-007): registers the `render_ui` tool — the model's only output
 * channel for generative UI. Component instructions, not frontend code: the
 * no-op body just confirms acceptance, and the browser half renders the
 * instruction with trusted components via the `tool.call.toolview` keyed
 * slot (inline) and the sidebar-right canvas tab (persistent surfaces).
 */

import type { Context } from '@deepseek-ai/cordis'
import { renderUiTool } from './render-ui-tool.ts'

/** Cordis function-plugin name. */
export const name = 'hibuddy-web-ui'

/** Required host services. */
export const inject = ['tools']

/** Register the generative-UI instruction tool. */
export function apply(ctx: Context): void {
  ctx.tools.register(renderUiTool)
}
