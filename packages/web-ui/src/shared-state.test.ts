/**
 * Shared task state core (PRD FR-05, S4-6): the pure merge rules both halves
 * rely on — last-writer-wins by stamp time (新者为准), the holder reported on
 * an older write, and strict session scoping.
 */
import { describe, expect, it } from 'vitest'
import { mergeEntry, SharedStateStore, type SharedStateEntry } from './shared-state.ts'

function entry(value: unknown, at: number, source: 'user' | 'agent' = 'agent'): SharedStateEntry {
  return { value, source, at }
}

describe('mergeEntry (新者为准)', () => {
  it('applies a newer write', () => {
    const result = mergeEntry(entry('old', 100), entry('new', 200))
    expect(result).toEqual({ ok: true, entry: entry('new', 200) })
  })

  it('applies the first write into an empty slot', () => {
    expect(mergeEntry(undefined, entry('v', 1))).toEqual({ ok: true, entry: entry('v', 1) })
  })

  it('applies an equal-time write (last commit wins)', () => {
    const result = mergeEntry(entry('first', 100), entry('second', 100))
    expect(result).toEqual({ ok: true, entry: entry('second', 100) })
  })

  it('rejects an older write and reports the holder', () => {
    const holder = entry({ kept: true }, 200, 'user')
    const result = mergeEntry(holder, entry('stale', 100))
    expect(result).toEqual({ ok: false, holder })
  })
})

describe('SharedStateStore', () => {
  it('writes and reads back one session snapshot', () => {
    const store = new SharedStateStore()
    store.write('s1', 'todo', entry(['a', 'b'], 100))
    store.write('s1', 'target-price', entry(42, 110, 'user'))
    expect(store.snapshotOf('s1')).toEqual({
      todo: entry(['a', 'b'], 100),
      'target-price': entry(42, 110, 'user'),
    })
  })

  it('rejects an out-of-order (older) write and keeps the holder', () => {
    const store = new SharedStateStore()
    store.write('s1', 'todo', entry('fresh', 200, 'agent'))
    const result = store.write('s1', 'todo', entry('stale user edit', 100, 'user'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.holder).toEqual(entry('fresh', 200, 'agent'))
    expect(store.snapshotOf('s1').todo).toEqual(entry('fresh', 200, 'agent'))
  })

  it('isolates sessions', () => {
    const store = new SharedStateStore()
    store.write('s1', 'k', entry('one', 100))
    expect(store.snapshotOf('s2')).toEqual({})
    store.write('s2', 'k', entry('two', 100))
    expect(store.snapshotOf('s1').k.value).toBe('one')
  })

  it('drops state with the session', () => {
    const store = new SharedStateStore()
    store.write('s1', 'k', entry('v', 100))
    store.dropSession('s1')
    expect(store.snapshotOf('s1')).toEqual({})
  })

  it('returns an empty snapshot for an unknown session', () => {
    expect(new SharedStateStore().snapshotOf('nope')).toEqual({})
  })
})
