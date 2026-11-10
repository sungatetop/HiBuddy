import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ticket } from './domain.ts'
import { renderSituation } from './situation.ts'
import { Store } from './store.ts'

let dir: string
let store: Store

/** Local-clock ticket helper (tz-safe: dates built from local components). */
function ticket(partial: Partial<Ticket> & { id: string }): Ticket {
  return {
    goal: '整理下载目录',
    mandate: 'explicit',
    origin: 'user',
    state: 'pending',
    createdAt: new Date(2026, 10, 10, 9, 0).toISOString(),
    updatedAt: new Date(2026, 10, 10, 9, 0).toISOString(),
    ...partial,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resident-situation-'))
  store = Store.open(dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const now = new Date(2026, 10, 10, 9, 12)

describe('renderSituation (perception B12′ §5.2, D2)', () => {
  it('renders the header, mode line and empty-state sections', () => {
    const out = renderSituation(store, { now })
    expect(out).toContain('【当前情境｜2026-11-10 09:12】')
    expect(out).not.toContain('工作区')
    expect(out).toContain('观察模式：开；免打扰：否；并行上限：2')
    expect(out).toContain('入站队列：0 条待处理')
    expect(out).not.toContain('进行中')
    expect(out).not.toContain('待审批')
    expect(out).not.toContain('最近完成')
  })

  it('renders workspace only when provided', () => {
    const out = renderSituation(store, { now, workspace: 'D:\\HibuddyWorkspace' })
    expect(out).toContain('【当前情境｜2026-11-10 09:12｜工作区 D:\\HibuddyWorkspace】')
  })

  it('lists active tickets sorted by state with durations and next due', () => {
    store.upsertTicket(
      ticket({
        id: 'tkt_aaaa',
        state: 'working',
        updatedAt: new Date(2026, 10, 10, 9, 9).toISOString(),
        sessionId: 'resident-worker-tkt_aaaa',
      }),
    )
    store.upsertTicket(ticket({ id: 'tkt_bbbb', state: 'pending', nextRunAt: new Date(2026, 10, 10, 10, 0).toISOString() }))
    store.upsertTicket(ticket({ id: 'tkt_cccc', state: 'awaiting_approval' }))
    store.upsertTicket(ticket({ id: 'tkt_dddd', state: 'completed', updatedAt: new Date(2026, 10, 10, 9, 0).toISOString() }))

    const out = renderSituation(store, { now })
    expect(out).toContain('进行中（3）：')
    // running first, then scheduled
    expect(out.indexOf('working 3 分钟')).toBeLessThan(out.indexOf('pending（10:00 到期）'))
    expect(out).toContain('- tkt_aaaa｜整理下载目录｜working 3 分钟｜resident-worker-tkt_aaaa')
    expect(out).toContain('- tkt_bbbb｜整理下载目录｜pending（10:00 到期）')
    expect(out).toContain('- tkt_cccc｜整理下载目录｜awaiting_approval 12 分钟')
    expect(out).toContain('最近完成（1）：tkt_dddd 已完成 09:00')
  })

  it('flags the quiet window and its current state', () => {
    store.setSetting('quietHours', { start: '22:00', end: '07:00' })
    expect(renderSituation(store, { now })).toContain('免打扰：否（22:00–07:00）')
    expect(renderSituation(store, { now: new Date(2026, 10, 10, 23, 30) })).toContain('免打扰：是（22:00–07:00）')
  })

  it('reflects observe-mode and worker-slot settings', () => {
    store.setSetting('observeMode', false)
    store.setSetting('workerSlots', 1)
    expect(renderSituation(store, { now })).toContain('观察模式：关；免打扰：否；并行上限：1')
  })

  it('lists pending approvals with their escalation flag', () => {
    const out = renderSituation(store, {
      now,
      pendingApprovals: [
        { id: 'apr_1234567890', ticketId: 't1', sessionId: 's1', toolName: 'write', reason: 'x', requiresUser: true, createdAt: 'x' },
        { id: 'apr_b', ticketId: 't2', sessionId: 's2', toolName: 'read', reason: 'y', requiresUser: false, createdAt: 'y' },
      ],
    })
    expect(out).toContain('待审批（2）：apr_123456…｜write｜需用户确认；apr_b｜read｜可代管')
  })

  it('truncates long goals and caps the active section', () => {
    for (let i = 0; i < 12; i++) {
      store.upsertTicket(ticket({ id: `tkt_${String(i).padStart(4, '0')}`, state: 'pending' }))
    }
    store.upsertTicket(
      ticket({
        id: 'tkt_long',
        state: 'working',
        goal: '一个特别长的任务目标，用来验证目标文本在情境快照里会被截断到四十个字符以内的边界条件',
        updatedAt: now.toISOString(),
      }),
    )
    const out = renderSituation(store, { now })
    expect(out).toContain('进行中（13）：')
    expect(out).toContain('（…还有 3 项）')
    expect(out).toContain('一个特别长的任务目标，用来验证目标文本在情境快照里会被截断到四十个字符以内的边界…')
  })
})
