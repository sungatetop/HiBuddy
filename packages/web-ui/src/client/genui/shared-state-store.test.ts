/**
 * Shared-state panel store (FR-05, S4-6): the client mirror applies the same
 * last-writer-wins merge as the host store, dedupes re-fed identical writes,
 * and scopes state per session.
 */
import { describe, expect, it } from 'vitest'
import { getSharedStateClientState, recordSharedStatePanelEdit, recordSharedStateToolWrite, subscribeSharedState } from './shared-state-store.ts'

/** Direct snapshot read (the `useSharedState` hook wraps exactly this getter). */
function snapshotOf(sessionId: string): Record<string, unknown> {
  return getSharedStateClientState().sessions[sessionId]?.snapshot ?? {}
}

describe('shared-state store', () => {
  it('feeds an authoritative tool write and serves it to the session', () => {
    const sessionId = `feed-${Date.now()}`
    recordSharedStateToolWrite(sessionId, 'todo', ['a'], 'agent', 1000)
    expect(snapshotOf(sessionId).todo).toEqual({ value: ['a'], source: 'agent', at: 1000 })
  })

  it('drops an older write and keeps the holder (新者为准)', () => {
    const sessionId = `older-${Date.now()}`
    recordSharedStateToolWrite(sessionId, 'k', 'fresh', 'agent', 2000)
    recordSharedStateToolWrite(sessionId, 'k', 'stale', 'user', 1000)
    expect(snapshotOf(sessionId).k).toEqual({ value: 'fresh', source: 'agent', at: 2000 })
  })

  it('lets an authoritative write supersede an optimistic panel edit', () => {
    const sessionId = `relay-${Date.now()}`
    recordSharedStatePanelEdit(sessionId, 'target', 'v1')
    expect(snapshotOf(sessionId).target).toMatchObject({ value: 'v1', source: 'user' })
    // The model relays the panel edit through the tool; the settled result
    // event is stamped LATER than the optimistic write.
    recordSharedStateToolWrite(sessionId, 'target', 'v1', 'user', Date.now() + 5)
    expect(snapshotOf(sessionId).target).toMatchObject({ value: 'v1', source: 'user' })
  })

  it('does not churn subscribers on an identical re-feed (page reload replay)', () => {
    const sessionId = `replay-${Date.now()}`
    let notifications = 0
    const unsubscribe = subscribeSharedState(() => {
      notifications += 1
    })
    recordSharedStateToolWrite(sessionId, 'k', { deep: [1, 2] }, 'agent', 1234)
    const afterFirst = notifications
    recordSharedStateToolWrite(sessionId, 'k', { deep: [1, 2] }, 'agent', 1234)
    expect(notifications).toBe(afterFirst)
    unsubscribe()
  })

  it('reads an unknown session as an empty snapshot', () => {
    expect(snapshotOf('nope-nope')).toEqual({})
    expect(getSharedStateClientState().sessions['nope-nope']).toBeUndefined()
  })
})
