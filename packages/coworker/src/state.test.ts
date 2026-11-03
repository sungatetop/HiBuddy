/**
 * Contract tests for session-scoped approval state (implementation-plan S3
 * task 5: 免再询记忆生命周期（会话×工具×等级）+ 拒绝计数). The lifecycle
 * below is the SR-01 promise: a grant lives exactly one session, one tool —
 * never persisted, never crossing sessions or tools.
 */
import { describe, expect, it } from 'vitest'
import { MAX_CONSECUTIVE_REJECTIONS } from './grading.ts'
import { ApprovalSessionState } from './state.ts'

describe('免再询 grant 生命周期（会话 × 工具）', () => {
  it('hits for the same session and tool only', () => {
    const state = new ApprovalSessionState()
    state.grant('session-a', 'write')
    expect(state.hasGrant('session-a', 'write')).toBe(true)
  })

  it('does not cross sessions（新会话恢复询问）', () => {
    const state = new ApprovalSessionState()
    state.grant('session-a', 'write')
    expect(state.hasGrant('session-b', 'write')).toBe(false)
  })

  it('does not cross tools（grant 只免被授权的那个工具）', () => {
    const state = new ApprovalSessionState()
    state.grant('session-a', 'write')
    expect(state.hasGrant('session-a', 'edit')).toBe(false)
  })

  it('revoke withdraws exactly one (session, tool) pair', () => {
    const state = new ApprovalSessionState()
    state.grant('session-a', 'write')
    expect(state.revoke('session-a', 'write')).toBe(true)
    expect(state.hasGrant('session-a', 'write')).toBe(false)
    expect(state.revoke('session-a', 'write')).toBe(false)
  })

  it('dropSession clears grants and strikes（会话销毁即失，SR-01）', () => {
    const state = new ApprovalSessionState()
    state.grant('session-a', 'write')
    state.addStrike('session-a', 'edit')
    state.dropSession('session-a')
    expect(state.hasGrant('session-a', 'write')).toBe(false)
    expect(state.strikesOf('session-a', 'edit')).toBe(0)
    expect(state.listGrants()).toEqual([])
  })

  it('listGrants snapshots every live grant', () => {
    const state = new ApprovalSessionState()
    state.grant('session-a', 'write')
    state.grant('session-a', 'edit')
    state.grant('session-b', 'write')
    expect(state.listGrants().sort(bySessionThenTool)).toEqual([
      { sessionId: 'session-a', toolName: 'edit' },
      { sessionId: 'session-a', toolName: 'write' },
      { sessionId: 'session-b', toolName: 'write' },
    ])
  })
})

describe('连续拒绝计数（FR-03 规则 2）', () => {
  it('counts consecutive rejections per session and tool', () => {
    const state = new ApprovalSessionState()
    expect(state.addStrike('session-a', 'write')).toBe(1)
    expect(state.addStrike('session-a', 'write')).toBe(2)
    expect(state.strikesOf('session-a', 'write')).toBe(2)
  })

  it('stops counting at the threshold for the stop-and-ask gate', () => {
    const state = new ApprovalSessionState()
    for (let i = 0; i < MAX_CONSECUTIVE_REJECTIONS; i += 1) state.addStrike('session-a', 'write')
    expect(state.strikesOf('session-a', 'write')).toBeGreaterThanOrEqual(MAX_CONSECUTIVE_REJECTIONS)
  })

  it('keeps per-tool streaks independent within a run', () => {
    const state = new ApprovalSessionState()
    state.addStrike('session-a', 'write')
    state.addStrike('session-a', 'write')
    expect(state.strikesOf('session-a', 'edit')).toBe(0)
  })

  it('an allow clears the streak for that tool only（clearStrikesFor）', () => {
    const state = new ApprovalSessionState()
    state.addStrike('session-a', 'write')
    state.addStrike('session-a', 'edit')
    state.clearStrikesFor('session-a', 'write')
    expect(state.strikesOf('session-a', 'write')).toBe(0)
    expect(state.strikesOf('session-a', 'edit')).toBe(1)
  })

  it('a new run resets every streak in the session（turn/start → clearStrikes）', () => {
    const state = new ApprovalSessionState()
    state.addStrike('session-a', 'write')
    state.addStrike('session-a', 'edit')
    state.clearStrikes('session-a')
    expect(state.strikesOf('session-a', 'write')).toBe(0)
    expect(state.strikesOf('session-a', 'edit')).toBe(0)
  })

  it('counts sessions in isolation', () => {
    const state = new ApprovalSessionState()
    state.addStrike('session-a', 'write')
    state.addStrike('session-a', 'write')
    state.addStrike('session-b', 'write')
    expect(state.strikesOf('session-a', 'write')).toBe(2)
    expect(state.strikesOf('session-b', 'write')).toBe(1)
  })
})

function bySessionThenTool(a: { sessionId: string; toolName: string }, b: { sessionId: string; toolName: string }): number {
  return a.sessionId.localeCompare(b.sessionId) || a.toolName.localeCompare(b.toolName)
}
