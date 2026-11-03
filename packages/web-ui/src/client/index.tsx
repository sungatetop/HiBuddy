/**
 * HiBuddy web-UI customization, client half.
 *
 * S3-2: enhanced tool-approval card. Registers a `conversation.composer`
 * chain entry that elects ahead of the official ui-approval takeover
 * (priority 1) whenever the pending interaction is an approval, and renders
 * HiBuddy's own card — full tool arguments, an impact note, and the three
 * decisions 批准 / 拒绝 / 本会话免再询 (the waiver POSTs the coworker
 * session-grant API, then answers `allowed-once` through the normal remote
 * waterfall). The official approval waterfall listener, locale namespace, and
 * shortcuts stay untouched.
 *
 * S4-2: generative-UI toolview. Registers the keyed `tool.call.toolview`
 * entry for the `render_ui` tool (ADR-007): a streaming-aware card that
 * projects the call's arguments into a typed instruction and renders it
 * through the trusted-component registry, with static degradation.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { HibuddyApprovalCard } from './approval-card.tsx'
import { en, zh, type ApprovalLocaleKey } from './locales.ts'
import { en as genuiEn, zh as genuiZh, type GenuiLocaleKey } from './genui/locales.ts'
import { RenderUiCard } from './genui/render-ui-card.tsx'

/** Required services: Slot registry and copy. */
export const inject = ['slots', 'locale']

/** Locale namespace of the enhanced card. */
const NS = 'hibuddy-approval'

/** Locale namespace of the generative-UI card. */
const GENUI_NS = 'hibuddy-genui'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HiBuddy enhanced approval card copy. */
    'hibuddy-approval': ApprovalLocaleKey
    /** HiBuddy generative-UI toolview copy. */
    'hibuddy-genui': GenuiLocaleKey
  }
}

/**
 * Install the copy dictionaries, the approval takeover, and the generative-UI
 * toolview.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hibuddy-web-ui: approval dictionaries')
  ctx.effect(
    () => ctx.locale.register(GENUI_NS, { zh: genuiZh, en: genuiEn }),
    'hibuddy-web-ui: generative-UI dictionaries',
  )
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    // Below the official ui-approval takeover (priority 1) so this entry
    // elects first for approvals; the priority tie with ui-user-questions
    // (default 0) is harmless — the selects discriminate disjoint
    // pending-interaction kinds ('approval' vs 'question'/'plan-review').
    priority: 0,
    select: ({ pendingInteraction }: ComposerChainProps): PendingApproval | null =>
      pendingInteraction?.kind === 'approval' ? pendingInteraction : null,
    locale: NS,
    inject: () => ({
      resolveReason: (reason: NonNullable<PendingApproval['displayReason']>) => ctx.locale.resolveText(reason),
    }),
  }, HibuddyApprovalCard))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'render_ui',
    locale: GENUI_NS,
  }, RenderUiCard))
}
