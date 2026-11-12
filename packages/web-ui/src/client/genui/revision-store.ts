/**
 * Client-side revision tracker (genui-agui-optimization.md G2, client half of
 * the staleness gate): a page-lifetime map of `session → instruction id →
 * latest revision`, fed by the turn-tail mirror from the durable chat nodes.
 *
 * The HOST gate (butler pump / render_ui registry) is the authority that
 * rejects stale send-backs before the model; this store is the UX half — a
 * surface older than the latest revision of its id renders read-only (static
 * fallback + notice) instead of letting the user click into a guaranteed
 * rejection. Module-level state, mirroring canvas-store.
 */
import { useSyncExternalStore } from 'react'

/** Store key: session-scoped (instruction ids may repeat across sessions). */
function keyOf(sessionId: string | undefined, id: string): string {
  return `${sessionId ?? ''}\u0000${id}`
}

let state: ReadonlyMap<string, number> = new Map()
const listeners = new Set<() => void>()

/** Publish a new immutable snapshot and notify subscribers. */
function commit(next: ReadonlyMap<string, number>): void {
  state = next
  for (const listener of listeners) listener()
}

/**
 * Record the latest revision observed for one instruction id (max-wins, so a
 * replaying older call can never regress the gate). Absent/invalid revisions
 * normalize to 1, matching the host registry.
 */
export function recordClientRevision(sessionId: string | undefined, id: string, revision: number | undefined): void {
  const normalized = typeof revision === 'number' && Number.isInteger(revision) && revision >= 1 ? revision : 1
  const key = keyOf(sessionId, id)
  const current = state.get(key)
  if (current !== undefined && normalized <= current) return
  const next = new Map(state)
  next.set(key, normalized)
  commit(next)
}

/** Subscribe to tracker changes; the listener runs on every commit. */
export function subscribeRevisions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Reactive staleness read for one surface: true when a NEWER revision of the
 * same id has been observed (absent revisions read as 1). Reference-stable
 * boolean snapshot for `useSyncExternalStore`.
 */
export function isSurfaceStale(sessionId: string | undefined, id: string | undefined, revision: number | undefined): boolean {
  if (id === undefined) return false
  const latest = state.get(keyOf(sessionId, id))
  if (latest === undefined) return false
  return latest > (revision ?? 1)
}

/** Hook form of {@link isSurfaceStale} (re-renders when the tracker advances). */
export function useSurfaceStale(sessionId: string | undefined, id: string | undefined, revision: number | undefined): boolean {
  return useSyncExternalStore(
    subscribeRevisions,
    () => isSurfaceStale(sessionId, id, revision),
    () => false,
  )
}
