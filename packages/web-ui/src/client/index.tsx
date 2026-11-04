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
 *
 * S4-4: canvas form (ADR-007 §3.3). Two-stage tab-type registration — stage
 * one registers the page type (`ctx.sidebarRightTabs`, opened by kind), stage
 * two the body under the same id (`sidebar.right.pane.tab` keyed slot). The
 * opener seam lets flow-scoped cards reveal the tab with `{ canvasId }`
 * navigation params.
 *
 * S4-5: interaction send-back (ADR-007 §3.4). Installs the conversation-send
 * seam — the explicit session-binding prompt channel (what
 * ConversationController.send resolves to internally) — so surface components
 * (form submit) can push one structured text message into the session as a
 * queued turn.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { HibuddyApprovalCard } from './approval-card.tsx'
import { en, zh, type ApprovalLocaleKey } from './locales.ts'
import { setCanvasOpener } from './genui/canvas-open.ts'
import { GenuiCanvasTab } from './genui/canvas-tab.tsx'
import { setConversationSender } from './genui/conversation-send.ts'
import { en as genuiEn, zh as genuiZh, type GenuiLocaleKey } from './genui/locales.ts'
import { RenderUiCard } from './genui/render-ui-card.tsx'
import { registerGenuiSurfaces } from './genui/surfaces.ts'
import { GenuiTurnTail } from './genui/turn-tail.tsx'

/** Required services: Slot registry, copy, the right-Sidebar faces (canvas), and sessions (send-back). */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions']

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

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Canvas instance to reveal — the render_ui instruction id. */
    'hibuddy-genui-canvas': {
      readonly canvasId: string
    }
  }
}

/**
 * Install the copy dictionaries, the approval takeover, and the generative-UI
 * toolview.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  registerGenuiSurfaces()
  // One-shot service capture (cordis discipline): callbacks registered here run
  // outside the plugin's injection scope, so they use the captured references.
  const locale = ctx.locale
  const sidebarRight = ctx.sidebarRight
  // Both the host-side dsh-session plugin and the client session controller
  // augment Context.sessions with different faces; in this package's typecheck
  // the host-side declaration wins the merge, so cast to the client face.
  const sessions = ctx.sessions as unknown as ISessions
  ctx.effect(() => locale.register(NS, { zh, en }), 'hibuddy-web-ui: approval dictionaries')
  ctx.effect(() => locale.register(GENUI_NS, { zh: genuiZh, en: genuiEn }), 'hibuddy-web-ui: generative-UI dictionaries')
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
      resolveReason: (reason: NonNullable<PendingApproval['displayReason']>) => locale.resolveText(reason),
    }),
  }, HibuddyApprovalCard))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'render_ui',
    locale: GENUI_NS,
  }, RenderUiCard))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    id: 'hibuddy-genui-tail',
    locale: GENUI_NS,
  }, GenuiTurnTail))
  // Canvas (ADR-007 §3.3), stage one: the page type — opened by kind, one page
  // per pane (a second open reveals the existing tab and re-navigates it).
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'hibuddy.genui-canvas',
    kind: 'hibuddy-genui-canvas',
    title: () => locale.resolveText({ en: 'Canvas', zh: '画布' }),
  }), 'hibuddy-web-ui: generative-UI canvas tab type')
  // Stage two: the body under the definition's own id.
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: 'hibuddy.genui-canvas',
    locale: GENUI_NS,
  }, GenuiCanvasTab))
  // Opener seam: flow cards call openGenuiCanvas(id) — the command uses the
  // captured sidebar face (handlers run outside the injection scope).
  setCanvasOpener((canvasId) => {
    sidebarRight.openTab('hibuddy-genui-canvas', { params: { canvasId } })
  })
  // Send-back seam (S4-5): surface events become one queued-turn text message.
  // The attribute path (`scope(id).conversation`) demands the caller run inside
  // a cordis injection scope — React event callbacks do not. `binding.session`
  // is exactly what ConversationController.send resolves internally
  // (scopedSession → binding.session.prompt([…], 'queue')), addressed explicitly.
  setConversationSender(async (sessionId, text) => {
    const binding = sessions.binding(sessionId as never)
    if (binding === undefined) throw new Error(`hibuddy-web-ui: session "${sessionId}" has no binding`)
    const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
    if (!result.ok) throw new Error(`hibuddy-web-ui: send-back rejected: ${result.error.code}: ${result.error.message}`)
  })
}
