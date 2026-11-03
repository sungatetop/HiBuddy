/**
 * Canvas instance store (ADR-007 §3.3): module-level, page-lifetime state that
 * mirrors settled `render_ui` calls with `target=canvas`.
 *
 * The right-sidebar tab body (`sidebar.right.pane.tab`) renders OUTSIDE the
 * chat slot scope, so it has no `useChat`; instead the chat-scoped turn-tail
 * (which re-renders from the durable chat nodes on every page load) records
 * versions here, and this store re-publishes them reference-stably for
 * `useSyncExternalStore`. Reload-safe: the turn tails rebuild the full version
 * history from the persisted nodes, so the canvas survives page reloads and
 * session switches within the page.
 */
import { useSyncExternalStore } from 'react'
import type { RenderUiInstruction } from './instruction.ts'

/** One settled canvas-target call: an immutable version of one canvas instance. */
export interface GenuiCanvasVersion {
  /** Monotonic record order (record sequence across the page lifetime). */
  readonly seq: number
  /** The settled tool call's id (dedup key — one record per call). */
  readonly callId: string
  /** The turn the call settled in (conversation turn number). */
  readonly turn: number
  /** The full instruction projected from the call's arguments. */
  readonly instruction: RenderUiInstruction
}

/** One canvas instance: the instruction `id` and its ascending versions. */
export interface GenuiCanvasInstance {
  readonly id: string
  readonly versions: ReadonlyArray<GenuiCanvasVersion>
}

interface CanvasStoreState {
  /** Instances in ascending last-update order (most recent last). */
  readonly instances: ReadonlyArray<GenuiCanvasInstance>
  /** Set of recorded call ids (dedup). */
  readonly calls: ReadonlySet<string>
}

let state: CanvasStoreState = { instances: [], calls: new Set() }
const listeners = new Set<() => void>()
let seq = 0

/** Publish a new immutable snapshot and notify subscribers. */
function commit(next: CanvasStoreState): void {
  state = next
  for (const listener of listeners) listener()
}

/**
 * Record one settled canvas-target call. Idempotent per call id; a repeated
 * canvas id appends a version, a new id opens a new instance.
 * @returns whether the INSTANCE was created by this call (first version).
 */
export function recordCanvasVersion(instruction: RenderUiInstruction, callId: string, turn: number): boolean {
  if (instruction.id === undefined || state.calls.has(callId)) return false
  const version: GenuiCanvasVersion = { seq: seq++, callId, turn, instruction }
  const existing = state.instances.find((instance) => instance.id === instruction.id)
  let fresh = false
  let instances: ReadonlyArray<GenuiCanvasInstance>
  if (existing === undefined) {
    fresh = true
    instances = [...state.instances, { id: instruction.id, versions: [version] }]
  } else {
    instances = state.instances
      .filter((instance) => instance.id !== instruction.id)
      .concat({ id: instruction.id, versions: [...existing.versions, version] })
  }
  commit({ instances, calls: new Set(state.calls).add(callId) })
  return fresh
}

/** Subscribe to canvas changes; the listener runs on every commit. */
export function subscribeCanvas(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reference-stable snapshot for `useSyncExternalStore`. */
export function getCanvasInstances(): ReadonlyArray<GenuiCanvasInstance> {
  return state.instances
}

/** Reactive read of all canvas instances (most recently updated last). */
export function useCanvasInstances(): ReadonlyArray<GenuiCanvasInstance> {
  return useSyncExternalStore(subscribeCanvas, getCanvasInstances)
}
