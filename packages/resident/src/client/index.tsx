/**
 * HiBuddy resident layer plugin — browser half.
 *
 * B1 skeleton: establishes the client-modules loading path (CJS factory
 * wrapper, see tsdown.config.ts) ahead of the resident panel (B8), which will
 * register the sidebar entry and the four-tab panel here. An empty apply is
 * deliberate: loading without errors IS the B1 acceptance for this face.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Host plugin body — this package ships browser presentation from B8 on. */
export function apply(ctx: ClientContext): void {
  void ctx
}
