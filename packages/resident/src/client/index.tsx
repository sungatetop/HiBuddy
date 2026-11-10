/**
 * HiBuddy resident layer plugin — browser half (ADR-011 D11).
 *
 * Registers the butler conversation as a first-class main panel: a sidebar
 * entry (`sidebar.panellist`) plus the keyed `main` seat rendered by
 * {@link ChatPage}. The panel reads the conversation ledger through the
 * same-origin `/resident/api/messages` routes; it never touches the dsh
 * session renderer, so assistant text and tool calls stay invisible.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactNode } from 'react'
import { ChatPage } from './chat-page.tsx'

/**
 * Required services. The loader passes the module exports as an object plugin,
 * so this declaration is what makes `ctx.slots` readable inside `apply` —
 * without it cordis throws "cannot get property slots without inject" and the
 * whole web boot aborts (one failed entry fails the frame). `uiWorkspace` is
 * the shell's session navigation service (open a worker conversation).
 */
export const inject = ['slots', 'uiWorkspace']

/** Main-panel id shared by the sidebar entry and the `main` seat. */
export const CHAT_PANEL_ID = 'hibuddy-chat'

/** Structural face of the shell's session navigator (no value import needed). */
interface WorkspaceNavigation {
  openSession(sessionId: string): void
}

/** Sidebar glyph for the butler panel. */
function ButlerIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.1c-.5.4-1.3 0-1.3-.7V6.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="10.5" r="1.1" fill="currentColor" />
      <circle cx="12.5" cy="10.5" r="1.1" fill="currentColor" />
      <circle cx="16" cy="10.5" r="1.1" fill="currentColor" />
    </svg>
  )
}

/** Registers the sidebar entry and the full central chat page. */
export function apply(ctx: ClientContext): void {
  const navigation = ctx.get('uiWorkspace') as unknown as WorkspaceNavigation | undefined
  const openSession = (sessionId: string): void => {
    navigation?.openSession(sessionId)
  }
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: CHAT_PANEL_ID,
        order: 5,
        label: () => '管家',
      },
      ButlerIcon,
    ),
  )
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: CHAT_PANEL_ID, inject: () => ({ openSession }) },
      ChatPage,
    ),
  )
}
