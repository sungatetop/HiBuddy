/**
 * Approval-decision mirror (PRD FR-08 + SR-01, S5-2): page-lifetime record of
 * the decisions the user presses on HiBuddy approval cards, keyed by tool call.
 *
 * The durable audit of an approval lives in the session log (an approved call
 * has its normal `tool/result`, a rejected one an error result), but the
 * decision AS an event (who chose what, and whether it was a session waiver)
 * is client presentation state — recorded here at card press time and joined
 * onto the run-timeline tool rows by callId. Module-level, like the canvas and
 * shared-state stores.
 */
import { useSyncExternalStore } from 'react'

/** One recorded card decision for one tool call. */
export interface ApprovalDecisionRecord {
  /** What the user chose on the HiBuddy card. */
  readonly decision: 'approved' | 'rejected' | 'waived'
  /** Tool the request was about. */
  readonly toolName: string
  /** Wall-clock epoch ms of the decision. */
  readonly at: number
}

const EMPTY: ReadonlyMap<string, ApprovalDecisionRecord> = new Map()

let state: ReadonlyMap<string, ApprovalDecisionRecord> = EMPTY
const listeners = new Set<() => void>()

/** Publish a new immutable map and notify subscribers. */
function commit(next: ReadonlyMap<string, ApprovalDecisionRecord>): void {
  state = next
  for (const listener of listeners) listener()
}

/**
 * Record one card decision. Idempotent per callId (a retry after a failed
 * answer overwrites nothing — the first settled decision stands).
 */
export function recordApprovalDecision(
  callId: string | undefined,
  toolName: string,
  decision: ApprovalDecisionRecord['decision'],
): void {
  if (callId === undefined || state.has(callId)) return
  commit(new Map(state).set(callId, { decision, toolName, at: Date.now() }))
}

/** Subscribe to decision changes; the listener runs on every commit. */
export function subscribeApprovalDecisions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reference-stable snapshot for `useSyncExternalStore`. */
export function getApprovalDecisions(): ReadonlyMap<string, ApprovalDecisionRecord> {
  return state
}

/** Reactive read of all recorded decisions keyed by tool call id. */
export function useApprovalDecisions(): ReadonlyMap<string, ApprovalDecisionRecord> {
  return useSyncExternalStore(subscribeApprovalDecisions, getApprovalDecisions)
}
