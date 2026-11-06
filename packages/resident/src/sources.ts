/**
 * Event-source framework (resident-design.md §4.1): a registry of source
 * kinds; each kind arms its instances and emits immutable Triggers through a
 * single callback. The orchestrator wires the callback to (persist trigger →
 * two-stage filter) so every future kind (mailbox/IM/files) plugs in with zero
 * orchestrator changes.
 */

import type { SourceInstance, Trigger } from './domain.ts'
import type { Store } from './store.ts'

/** Consumer of emitted triggers; the plugin wires persist + filter here. */
export type TriggerEmitter = (trigger: Trigger) => void

/** One source kind (e.g. `monitor`); instances live in `source_instances`. */
export interface SourceKind {
  readonly kind: string
  /** Validate config and begin polling/scheduling; emit Triggers via `emit`. */
  start(instance: SourceInstance, emit: TriggerEmitter): void | Promise<void>
  /** Stop the instance's polling/scheduling (idempotent). */
  stop(instanceId: string): void
}

/**
 * Registry of the resident layer's source kinds. `startAll` arms every
 * enabled instance whose kind is registered (startup reconciliation for
 * sources is a no-op beyond re-arming: read positions live in SQLite).
 */
export class SourceRegistry {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly started: Array<{ kind: SourceKind; instanceId: string }> = []

  register(kind: SourceKind): void {
    this.kinds.set(kind.kind, kind)
  }

  get(kind: string): SourceKind | undefined {
    return this.kinds.get(kind)
  }

  /** Arm all enabled instances of registered kinds; returns how many started. */
  startAll(store: Store, emit: TriggerEmitter): number {
    let count = 0
    for (const source of store.listSources()) {
      const kind = this.kinds.get(source.kind)
      if (!kind || !source.enabled) continue
      void kind.start(source, emit)
      this.started.push({ kind, instanceId: source.id })
      count += 1
    }
    return count
  }

  /** Disarm everything started by `startAll`; safe to call on dispose. */
  stopAll(): void {
    for (const entry of this.started) entry.kind.stop(entry.instanceId)
    this.started.length = 0
  }
}
