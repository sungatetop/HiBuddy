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
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { HibuddyApprovalCard } from './approval-card.tsx'
import { en, zh, type ApprovalLocaleKey } from './locales.ts'

/** Required services: Slot registry and copy. */
export const inject = ['slots', 'locale']

/** Locale namespace of the enhanced card. */
const NS = 'hibuddy-approval'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HiBuddy enhanced approval card copy. */
    'hibuddy-approval': ApprovalLocaleKey
  }
}

/**
 * Install the approval copy and the composer takeover.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hibuddy-web-ui: approval dictionaries')
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
}
