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
 *
 * S4-6: shared-state panel (FR-05). Registers the right-sidebar tab whose
 * body lists the run-level shared task state with source/time provenance;
 * the user's edit lands optimistically and is relayed to the agent as one
 * `[shared-state update]` queued-turn message (the send-back seam).
 *
 * S5-1 (FR-06): BYOK extension cards on the Models settings page — the
 * `settings.models.footer` recommendation card and the per-provider
 * connection-check card (`settings.models.provider-card`, keyed by adapter
 * family settings namespace). The check runs host-side through the `hibuddy`
 * Typert remote namespace (`verifyProvider`): one minimal completion, no key
 * material ever reaches the client.
 *
 * S5-2 (FR-08): Run-timeline tab — same two-stage registration as the canvas,
 * plus a `guide` capsule on the start page as the user-reachable entry (the
 * body defaults to the latest run; run chips switch turns). The body reads the
 * viewed session binding's event source directly (no
 * chat-scope coupling), so timelines live-append while a run streams and
 * rebuild from durable history after a page reload. Approval decisions
 * pressed on HiBuddy cards are recorded into a page-lifetime mirror and
 * joined into the timeline by callId.
 *
 * S5-4 (FR-09): quota notice takeover — the `shell.quota-notice` chain entry
 * replaces the official generic Toast with an actionable card (notice copy +
 * one-click jump to the provider configuration), covering the QUOTA /
 * ACCOUNT_QUOTA codes that fire a frame-wide notice.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ISessions, SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { Button, IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { HibuddyApprovalCard } from './approval-card.tsx'
import { en as byokEn, zh as byokZh, type ByokLocaleKey } from './byok/locales.ts'
import { RecommendCard } from './byok/recommend-card.tsx'
import { VerifyProviderCard } from './byok/verify-card.tsx'
import { HIBUDDY_REMOTE } from './byok/verify-remote.ts'
import { en, zh, type ApprovalLocaleKey } from './locales.ts'
import { setCanvasOpener } from './genui/canvas-open.ts'
import { GenuiCanvasTab } from './genui/canvas-tab.tsx'
import { setConversationSender } from './genui/conversation-send.ts'
import { en as genuiEn, zh as genuiZh, type GenuiLocaleKey } from './genui/locales.ts'
import { RenderUiCard } from './genui/render-ui-card.tsx'
import { registerGenuiSurfaces } from './genui/surfaces.ts'
import { setSubmitButton } from './genui/submit-button.tsx'
import { setSharedStateOpener } from './genui/shared-state-open.ts'
import { GenuiSharedStateTab } from './genui/shared-state-tab.tsx'
import { GenuiTurnTail } from './genui/turn-tail.tsx'
import { en as quotaEn, zh as quotaZh, type QuotaLocaleKey } from './quota-notice-locales.ts'
import { HibuddyQuotaNotice } from './quota-notice.tsx'
import { en as runEn, zh as runZh, type RunLocaleKey } from './run-timeline/locales.ts'
import { GenuiRunTimelineTab } from './run-timeline/tab.tsx'
import type { VerifyProviderOutcome } from '../verify-provider.ts'

/** Required services: Slot registry, copy, the right-Sidebar faces (canvas), sessions (send-back), and the typed Remote mount. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'remote']

/** Locale namespace of the enhanced card. */
const NS = 'hibuddy-approval'

/** Locale namespace of the generative-UI card. */
const GENUI_NS = 'hibuddy-genui'

/** Locale namespace of the BYOK Models-page cards. */
const BYOK_NS = 'hibuddy-byok'

/** Locale namespace of the Run-timeline tab. */
const RUN_NS = 'hibuddy-run'

/** Locale namespace of the quota notice card. */
const QUOTA_NS = 'hibuddy-quota'

/** Adapter-family settings namespaces whose provider cards carry the check. */
const PROVIDER_SETTINGS_NS = ['llm-deepseek', 'llm-pi-ai'] as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HiBuddy enhanced approval card copy. */
    'hibuddy-approval': ApprovalLocaleKey
    /** HiBuddy generative-UI toolview copy. */
    'hibuddy-genui': GenuiLocaleKey
    /** HiBuddy BYOK Models-page cards copy. */
    'hibuddy-byok': ByokLocaleKey
    /** HiBuddy Run-timeline tab copy. */
    'hibuddy-run': RunLocaleKey
    /** HiBuddy quota notice card copy. */
    'hibuddy-quota': QuotaLocaleKey
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    /** HiBuddy host-side extension RPCs (Models-page provider probe). */
    hibuddy: {
      verifyProvider: (provider: string) => Promise<RemoteResult<VerifyProviderOutcome>>
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Canvas instance to reveal — the render_ui instruction id. */
    'hibuddy-genui-canvas': {
      readonly canvasId: string
    }
    /** Run to reveal in the timeline tab — the conversation turn number. */
    'hibuddy-run-timeline': {
      readonly turn: number
    }
  }
}

/**
 * Install the copy dictionaries, the approval takeover, and the generative-UI
 * toolview. Mounting the `hibuddy` remote contribution first keeps the
 * namespace visible before any card can call it (dsh only exposes client
 * Remote namespaces mounted through explicit contributions).
 * @param ctx - Client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  registerGenuiSurfaces()
  // Themed submit button for the form surface (the embedder face keeps a
  // plain fallback when this apply never runs).
  setSubmitButton((props) => (
    <Button variant="primary" onClick={props.onClick}>{props.children}</Button>
  ))
  // One-shot service capture (cordis discipline): callbacks registered here run
  // outside the plugin's injection scope, so they use the captured references.
  const locale = ctx.locale
  const sidebarRight = ctx.sidebarRight
  const remote = ctx.remote
  // S5-1: mount the hand-written `hibuddy` namespace contribution — the same
  // mechanism the official api-remotes client uses for its generated ones.
  await remote.$mount(HIBUDDY_REMOTE)
  // The mounter cannot declare its own namespace in `inject` (cordis would
  // wait forever for a service only this fiber creates), and `ctx.remote
  // .hibuddy` resolves through that same fiber-inject table. Resolve the just-
  // mounted namespace service from the reflect store directly instead.
  const hibuddy = ctx.reflect.get('remote.hibuddy', false) as {
    verifyProvider(route: string): Promise<RemoteResult<VerifyProviderOutcome>>
  }
  // Both the host-side dsh-session plugin and the client session controller
  // augment Context.sessions with different faces; in this package's typecheck
  // the host-side declaration wins the merge, so cast to the client face.
  const sessions = ctx.sessions as unknown as ISessions
  ctx.effect(() => locale.register(NS, { zh, en }), 'hibuddy-web-ui: approval dictionaries')
  ctx.effect(() => locale.register(GENUI_NS, { zh: genuiZh, en: genuiEn }), 'hibuddy-web-ui: generative-UI dictionaries')
  ctx.effect(() => locale.register(BYOK_NS, { zh: byokZh, en: byokEn }), 'hibuddy-web-ui: BYOK dictionaries')
  ctx.effect(() => locale.register(RUN_NS, { zh: runZh, en: runEn }), 'hibuddy-web-ui: run-timeline dictionaries')
  ctx.effect(() => locale.register(QUOTA_NS, { zh: quotaZh, en: quotaEn }), 'hibuddy-web-ui: quota-notice dictionaries')
  // BYOK (S5-1, FR-06): the host-side probe seam folded into the wire result —
  // carrier failures fold into RemoteResult's error branch, so only assembly
  // faults reject; both map onto the card's outcome union.
  const verifyProvider = async (route: string): Promise<VerifyProviderOutcome> => {
    try {
      const response = await hibuddy.verifyProvider(route)
      if (response.ok) return response.value
      // Carrier failure (offline, transport fault): outcome-shaped, surfaced in
      // the card as an unknown-reason probe failure.
      return { ok: false, reason: 'unknown', detail: response.error.message }
    } catch (error) {
      // Assembly faults reject; the card renders them as unreachable.
      return { ok: false, reason: 'network', detail: error instanceof Error ? error.message : String(error) }
    }
  }
  // Footer recommendation card (list seat) after the provider rows.
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'hibuddy-recommend',
    locale: BYOK_NS,
  }, RecommendCard))
  // Connection-check card inside every provider card of each adapter family
  // (keyed seat, key = settingsNs): one registration covers shipped, added,
  // and hand-declared rows of that family.
  for (const settingsNs of PROVIDER_SETTINGS_NS) {
    ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
      name: 'settings.models.provider-card',
      key: settingsNs,
      locale: BYOK_NS,
      inject: () => ({ verifyProvider }),
    }, VerifyProviderCard))
  }
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
  // Shared-state tab (S4-6, FR-05): the user's editing surface for the
  // run-level shared task state — same two-stage registration as the canvas.
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'hibuddy.shared-state',
    kind: 'hibuddy-shared-state',
    title: () => locale.resolveText({ en: 'Shared state', zh: '共享状态' }),
  }), 'hibuddy-web-ui: shared-state tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: 'hibuddy.shared-state',
    locale: GENUI_NS,
  }, GenuiSharedStateTab))
  // Run-timeline tab (S5-2, FR-08): same two-stage registration. The body owns
  // its data — it reads the viewed session binding's event source directly
  // (the contiguous window the Conversation assembles from), so live append
  // and durable rebuild both come for free without any chat-scope feeder.
  const getEventSource = (sessionId: string): SessionEventSource | undefined =>
    (sessions as unknown as ISessions).binding(sessionId as never)?.eventSource
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'hibuddy.run-timeline',
    kind: 'hibuddy-run-timeline',
    title: () => locale.resolveText({ en: 'Run timeline', zh: 'Run 时间线' }),
    // FR-08 user entry: a guide capsule on the start page opens the timeline
    // page (no navigation params — the body defaults to the latest run; run
    // chips switch turns). Picking it replaces the guide, per dockkit doors.
    guide: [{
      id: 'timeline',
      order: 100,
      icon: IconClockOutlineRegular,
      title: () => locale.resolveText({ en: 'Run timeline', zh: 'Run 时间线' }),
      description: () => locale.resolveText({
        en: 'Review every run of this session',
        zh: '回看本会话每次 Run 的过程与输出',
      }),
    }],
  }), 'hibuddy-web-ui: run-timeline tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: 'hibuddy.run-timeline',
    locale: RUN_NS,
    inject: () => ({ getEventSource }),
  }, GenuiRunTimelineTab))
  // Quota notice takeover (S5-4, FR-09): claims every frame-wide quota notice
  // (the host only constructs owners for QUOTA / ACCOUNT_QUOTA) and renders
  // the actionable card instead of the generic Toast.
  ctx.slots.inject('shell.quota-notice', () => ctx.slots.register({
    name: 'shell.quota-notice',
    locale: QUOTA_NS,
    select: (owner) => owner,
  }, HibuddyQuotaNotice))
  // Opener seam: flow cards call openGenuiCanvas(id) — the command uses the
  // captured sidebar face (handlers run outside the injection scope).
  setCanvasOpener((canvasId) => {
    sidebarRight.openTab('hibuddy-genui-canvas', { params: { canvasId } })
  })
  // Shared-state opener seam (S4-6): the turn tails reveal the panel on the
  // first observed write; no navigation params for this kind.
  setSharedStateOpener(() => {
    sidebarRight.openTab('hibuddy-shared-state')
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
