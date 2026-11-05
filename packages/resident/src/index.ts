/**
 * HiBuddy resident layer plugin — host half.
 *
 * S7-B (resident-design.md): worker sessions are ordinary dsh sessions; this
 * plugin is the deterministic orchestration layer ABOVE them — event sources,
 * two-stage filtering, tickets, worker dispatch, notifications, durable state.
 * The user only states goals; worker sessions are created/resumed/stopped by
 * this layer and never faced directly.
 *
 * B1 skeleton: the stateDir deployment gate only (decision D3 — refuse to
 * boot without a configured persistence root). B2 adds SQLite persistence and
 * startup reconciliation on top of the resolved directory.
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveStateDir, type ResidentConfig } from './state-dir.ts'

/** Cordis function-plugin name. */
export const name = 'hibuddy-resident'

/** Resolved after the gate passes; consumed by B2+ (persistence, scheduler). */
let stateDir: string | undefined

/** Current stateDir, once the gate has passed. */
export function currentStateDir(): string | undefined {
  return stateDir
}

/**
 * Resident orchestrator entry: enforce the stateDir gate, then (B2+) start
 * persistence, source registry and the scheduler on top of it.
 * @param ctx - host root context.
 * @param config - raw config from the patch row (stateDir required — D3).
 */
export function apply(ctx: Context, config?: ResidentConfig): void {
  stateDir = resolveStateDir(config)
  ctx.logger('hibuddy-resident').info('started, stateDir: %s', stateDir)
}
