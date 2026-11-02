/** HiBuddy brand occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Slot-registry ambient augmentations: add `ctx.slots` and the brand slot
// declarations to the client Context type (type-only, dropped at build time).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { HibuddyBrandMark, HibuddyBrandName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the sidebar brand slots as one declaration-aware registration set,
 * following the official brand package's composition pattern: wait on each
 * declaration, then install both occupants atomically via a generator.
 * Also brand the page title: dsh ships a static `<title>` inside
 * dsh-web-frontend/dist/index.html with no runtime config point (checked
 * against dsh 0.2.1-rc.5 — no official client-ui package touches
 * document.title), so the brand package owns it from the client-module
 * extension surface instead of touching the private serving layer.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  document.title = 'HiBuddy'
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, HibuddyBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, HibuddyBrandName)
    }),
  )
}
