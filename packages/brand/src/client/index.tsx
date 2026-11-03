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
 * Also brand the page title via the interceptor below (all writers, incl.
 * dsh-client-ui-layout's DocumentTitle, flow through it).
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  brandDocumentTitle()
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, HibuddyBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, HibuddyBrandName)
    }),
  )
}

/**
 * Take over the browser tab title.
 *
 * dsh has no runtime title config point (checked against dsh 0.2.1-rc.5):
 * dsh-web-frontend ships a static `<title>DeepSeek Harness</title>` in
 * index.html, and dsh-client-ui-layout hardcodes `productTitle =
 * "DeepSeek Harness"` inside a DocumentTitle component that rewrites
 * document.title on every session-title change (`"<session> — DeepSeek
 * Harness"`) and restores the product title on unmount. Instead of racing
 * those writers, install an instance-level setter on `document` that rewrites
 * every assignment — session titles render as "<session> — HiBuddy", the
 * static/product value renders as "HiBuddy" — and rewrite the current value
 * once for the static HTML title. Entirely inside our client module: no dsh
 * source or private assembly layer is touched. Caveat: the literal string
 * "DeepSeek Harness" is rewritten wherever it appears in a written title
 * (display only; stored data is unaffected).
 */
function brandDocumentTitle(): void {
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'title')
  // Capture onto consts: the closure below cannot see this function's
  // undefined-narrowing, and `descriptor.set/get` stay optional on the type.
  const originalGet = descriptor?.get
  const originalSet = descriptor?.set
  if (!originalGet || !originalSet) return
  const rewrite = <T,>(value: T): T =>
    typeof value === 'string' ? (value.replaceAll('DeepSeek Harness', 'HiBuddy') as T) : value
  Object.defineProperty(document, 'title', {
    configurable: true,
    get: () => originalGet.call(document),
    set: (value: unknown) => originalSet.call(document, rewrite(value)),
  })
  document.title = rewrite(document.title)
}
