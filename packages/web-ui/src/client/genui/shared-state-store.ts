/**
 * Shared-state panel store (PRD FR-05, S4-6): module-level, page-lifetime
 * mirror of the session's shared task state.
 *
 * The right-sidebar tab body renders OUTSIDE the chat slot scope (no
 * `useChat`), so the chat-scoped turn tails feed writes here from the durable
 * `shared_state` tool results (same pattern as the canvas store); the panel's
 * own edits land optimistically and are superseded by the authoritative feed
 * when the model relays them through the tool. Merging is the same
 * last-writer-wins rule as the host store (newest `at` wins), so replays on
 * page reload are idempotent.
 */
import { useSyncExternalStore } from 'react'
import { mergeEntry, type SharedStateEntry, type SharedStateSnapshot, type SharedStateSource } from '../../shared-state.ts'

interface SessionState {
  readonly snapshot: SharedStateSnapshot
}

interface SharedStateClientState {
  /** Per-session snapshots, keyed by session id. */
  readonly sessions: Readonly<Record<string, SessionState>>
}

let state: SharedStateClientState = { sessions: {} }
const listeners = new Set<() => void>()

/** Publish a new immutable snapshot and notify subscribers. */
function commit(next: SharedStateClientState): void {
  state = next
  for (const listener of listeners) listener()
}

/** Entry equivalence: a re-fed identical write must not churn subscribers. */
function sameEntry(a: SharedStateEntry, b: SharedStateEntry): boolean {
  return a.at === b.at && a.source === b.source && JSON.stringify(a.value) === JSON.stringify(b.value)
}

/**
 * Apply one write into the session's mirror (last-writer-wins by `at`). An
 * incoming write older than the held entry is dropped — the holder stays.
 * Re-fed identical writes are no-ops.
 */
export function recordSharedStateWrite(sessionId: string, key: string, entry: SharedStateEntry): void {
  const session = state.sessions[sessionId]
  const existing = session?.snapshot[key]
  const result = mergeEntry(existing, entry)
  if (!result.ok) return
  if (existing !== undefined && sameEntry(existing, result.entry)) return
  commit({
    sessions: {
      ...state.sessions,
      [sessionId]: { snapshot: { ...session?.snapshot, [key]: result.entry } },
    },
  })
}

/**
 * Record one authoritative write observed from a settled `shared_state` tool
 * result (`op:"set"`): value/source from the call arguments, time from the
 * result event's own epoch ms.
 */
export function recordSharedStateToolWrite(sessionId: string, key: string, value: unknown, source: SharedStateSource, at: number): void {
  recordSharedStateWrite(sessionId, key, { value, source, at })
}

/** One optimistic panel edit (source `user`, stamped now). The model relays it. */
export function recordSharedStatePanelEdit(sessionId: string, key: string, value: unknown): void {
  recordSharedStateWrite(sessionId, key, { value, source: 'user', at: Date.now() })
}

/** Subscribe to shared-state changes; the listener runs on every commit. */
export function subscribeSharedState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reference-stable full snapshot for `useSyncExternalStore`. */
export function getSharedStateClientState(): SharedStateClientState {
  return state
}

/** Reactive read of one session's shared-state snapshot. */
export function useSharedState(sessionId: string | undefined): SharedStateSnapshot {
  const clientState = useSyncExternalStore(subscribeSharedState, getSharedStateClientState)
  return (sessionId !== undefined ? clientState.sessions[sessionId]?.snapshot : undefined) ?? {}
}
