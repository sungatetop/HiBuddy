/**
 * Per-turn situation snapshot (perception B12′ §5.2, D2).
 *
 * Deterministic context assembled fresh on every pump — the facts the butler
 * should not have to remember: active tickets, pending approvals, the inbound
 * queue, mode switches and the bound workspace. Capped and truncated so the
 * envelope stays scannable. A snapshot is a start-of-turn fact; state changes
 * mid-turn are corrected by the later receipt/event.
 */

import type { PendingApproval } from './approvals.ts'
import { isTerminal } from './domain.ts'
import { inQuietWindow, parseQuietWindow } from './messages.ts'
import type { Store } from './store.ts'

/** Per-section caps (design §5.2). */
const ACTIVE_MAX = 10
const APPROVALS_MAX = 5
const RECENT_MAX = 3
const GOAL_MAX = 40
const TOTAL_MAX = 1200

/** Clip a string to `max` chars, marking the cut. */
function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Compact ticket/approval id: `tkt_<uuid>` → `tkt_<first 10>…`. */
function compactId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 10)}…`
}

/** Local-time HH:MM of an ISO instant; the raw string when unparseable. */
function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Local-time label of the snapshot instant (`YYYY-MM-DD HH:MM`). */
function instantLabel(date: Date): string {
  return (
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-` +
    `${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:` +
    `${String(date.getMinutes()).padStart(2, '0')}`
  )
}

/** State-since duration, estimated from `ticket.updatedAt` (design §5.2). */
function durationLabel(sinceIso: string, now: Date): string {
  const ms = now.getTime() - new Date(sinceIso).getTime()
  if (!Number.isFinite(ms) || ms < 60_000) return '不足1分钟'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时${minutes % 60} 分`
}

/** Render order for the active section (running → scheduled → failed). */
const STATE_RANK: Record<string, number> = {
  working: 0,
  awaiting_approval: 1,
  pending: 2,
  failed: 3,
}

export interface SituationOptions {
  /** Injected clock for deterministic tests. */
  now?: Date
  /** Bound workspace root of the butler session. */
  workspace?: string
  /** Pending worker approvals routed into this conversation. */
  pendingApprovals?: PendingApproval[]
}

/**
 * Assembles the situation snapshot for one butler turn. All facts are read
 * fresh from the store — no new table, no caching; `updatedAt` estimates how
 * long a state has lasted. Empty sections are omitted (absence = zero items).
 */
export function renderSituation(store: Store, options: SituationOptions = {}): string {
  const now = options.now ?? new Date()
  const lines: string[] = []

  const head = [`【当前情境｜${instantLabel(now)}`]
  if (options.workspace !== undefined) head.push(`工作区 ${options.workspace}`)
  lines.push(`${head.join('｜')}】`)

  const observe = store.getSetting<unknown>('observeMode') !== false
  const slots = store.getSetting<number>('workerSlots')
  const mode = [`观察模式：${observe ? '开' : '关'}`]
  const quietWindow = parseQuietWindow(store.getSetting<unknown>('quietHours'))
  if (quietWindow !== undefined) {
    mode.push(`免打扰：${inQuietWindow(now, quietWindow) ? '是' : '否'}（${quietWindow.start}–${quietWindow.end}）`)
  } else {
    mode.push('免打扰：否')
  }
  mode.push(`并行上限：${typeof slots === 'number' && slots >= 1 ? Math.floor(slots) : 2}`)
  lines.push(mode.join('；'))

  const tickets = store.listTickets()
  const active = tickets
    .filter((ticket) => !isTerminal(ticket.state))
    .sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9))
  if (active.length > 0) {
    const shown = active.slice(0, ACTIVE_MAX)
    const rows = shown.map((ticket) => {
      const goal = clip(ticket.goal, GOAL_MAX)
      const state =
        ticket.state === 'pending'
          ? ticket.nextRunAt
            ? `pending（${clockOf(ticket.nextRunAt)} 到期）`
            : 'pending'
          : `${ticket.state} ${durationLabel(ticket.updatedAt, now)}`
      const session = ticket.sessionId !== undefined ? `｜${ticket.sessionId}` : ''
      return `- ${compactId(ticket.id)}｜${goal}｜${state}${session}`
    })
    const more = active.length > ACTIVE_MAX ? `（…还有 ${active.length - ACTIVE_MAX} 项）` : ''
    lines.push(`进行中（${active.length}）：`, ...rows, ...(more !== '' ? [more] : []))
  }

  const approvals = options.pendingApprovals ?? []
  if (approvals.length > 0) {
    const shown = approvals.slice(0, APPROVALS_MAX)
    const detail = shown
      .map(
        (approval) =>
          `${compactId(approval.id)}｜${approval.toolName}｜${approval.requiresUser ? '需用户确认' : '可代管'}`,
      )
      .join('；')
    const more = approvals.length > APPROVALS_MAX ? `（…还有 ${approvals.length - APPROVALS_MAX} 项）` : ''
    lines.push(`待审批（${approvals.length}）：${detail}${more}`)
  }

  lines.push(`入站队列：${store.countPendingInbound()} 条待处理`)

  const recent = tickets
    .filter((ticket) => ticket.state === 'completed')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, RECENT_MAX)
  if (recent.length > 0) {
    lines.push(
      `最近完成（${recent.length}）：${recent
        .map((ticket) => `${compactId(ticket.id)} 已完成 ${clockOf(ticket.updatedAt)}`)
        .join('；')}`,
    )
  }

  const result = lines.join('\n')
  return result.length <= TOTAL_MAX ? result : `${result.slice(0, TOTAL_MAX)}…`
}
