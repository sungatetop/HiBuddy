/**
 * Run-level shared task state (PRD FR-05, S4-6) — the pure merge core shared
 * by the host-side `shared_state` tool and the browser-side panel store.
 *
 * Model: a flat map of key → entry, every write stamped with its source
 * (`user` panel edit vs `agent` tool write) and a wall-clock timestamp. The
 * conflict rule is last-writer-wins by timestamp: an incoming write OLDER
 * than the held entry is rejected and the holder is reported back (新者为准并
 * 提示), so an out-of-order application (e.g. the model relaying a stale panel
 * edit after it already advanced the value) can never clobber fresh state.
 *
 * Pure data only — no network, no fs, no host services (SR-02 surface).
 */

/** Who produced one entry. */
export type SharedStateSource = 'user' | 'agent'

/** One stamped shared-state entry. */
export interface SharedStateEntry {
  readonly value: unknown
  readonly source: SharedStateSource
  readonly at: number
}

/** Flat snapshot: key → entry. */
export type SharedStateSnapshot = Readonly<Record<string, SharedStateEntry>>

/** Outcome of one write: applied, or rejected by a newer holder. */
export type SharedStateWrite =
  | { readonly ok: true; readonly entry: SharedStateEntry }
  | { readonly ok: false; readonly holder: SharedStateEntry }

/** Merge one incoming write into one entry slot (新者为准). Pure. */
export function mergeEntry(existing: SharedStateEntry | undefined, incoming: SharedStateEntry): SharedStateWrite {
  if (existing !== undefined && incoming.at < existing.at) return { ok: false, holder: existing }
  return { ok: true, entry: incoming }
}

/** Session-scoped shared-state store (host half owns the authoritative copy). */
export class SharedStateStore {
  readonly #sessions = new Map<string, Map<string, SharedStateEntry>>()

  /** Current snapshot of one session (empty object when nothing was written). */
  snapshotOf(sessionId: string): SharedStateSnapshot {
    const entries = this.#sessions.get(sessionId)
    if (entries === undefined) return {}
    return Object.fromEntries(entries)
  }

  /**
   * Apply one write. An incoming write older than the held entry is rejected
   * and the holder reported (A6 新者为准并提示); the session must exist in
   * the caller's ledger otherwise a fresh map is created.
   */
  write(sessionId: string, key: string, incoming: SharedStateEntry): SharedStateWrite {
    let entries = this.#sessions.get(sessionId)
    if (entries === undefined) {
      entries = new Map()
      this.#sessions.set(sessionId, entries)
    }
    const result = mergeEntry(entries.get(key), incoming)
    if (result.ok) entries.set(key, result.entry)
    return result
  }

  /** The session is gone — drop its state (session-scoped, in-memory only). */
  dropSession(sessionId: string): void {
    this.#sessions.delete(sessionId)
  }
}
