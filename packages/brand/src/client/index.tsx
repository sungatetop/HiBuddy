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
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, HibuddyBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, HibuddyBrandName)
    }),
  )
}
