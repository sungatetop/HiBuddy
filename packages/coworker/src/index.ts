/**
 * HiBuddy coworker core plugin — host half.
 *
 * Approval layer (S3, ADR-009 §2): dsh preset-standard already owns the tool
 * set and the two-knob approval mechanism (sandbox mode × approval policy ×
 * `approval/request` waterfall). This plugin adds the three PRD gaps only:
 *
 * 1. L2 default-off — `tools/pre-execute` denies bash/pwsh up front with
 *    model-facing guidance (strike-counted); the `approval/request` answerer
 *    rejects any L2 ask that still escalates (backstop).
 * 2. L1 confirm + session re-ask grant — escalated non-L2 calls consult the
 *    session grant store (免再询, written by the web approval card via the
 *    grants API): a hit answers `allowed-once` without prompting; a miss
 *    delegates `next()` to the interactive answerer (browser card).
 * 3. Stop-and-ask after 3 consecutive rejections in one run — the
 *    pre-execute gate swaps rejection for a deny whose reason tells the model
 *    to stop retrying and ask the user (FR-03 rule 2); the streak resets on
 *    turn/start and on an allow.
 *
 * Durable audit (approval/asked + approval/decided, tool/call + tool/result)
 * stays entirely in dsh's native session log (FR-08) — no custom storage.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_CONSECUTIVE_REJECTIONS, l2DisabledReason, riskLevelOf, stopAndAskReason } from './grading.ts'
import { registerGrantsApi } from './grants-api.ts'
import { ApprovalSessionState } from './state.ts'

/** Cordis function-plugin name. */
export const name = 'hibuddy-coworker'

/** Wire the approval layer for every agent/session in this composition. */
export function apply(ctx: Context): void {
  const state = new ApprovalSessionState()

  // Front of the pre-execute chain: L2 default-off (strike-counted) and the
  // stop-and-ask gate once a tool collected too many consecutive rejections.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const sessionId: SessionId | undefined = exec.agent?.session.id
    if (riskLevelOf(exec.name) === 'L2') {
      if (sessionId !== undefined) state.addStrike(sessionId, exec.name)
      return { kind: 'deny', reason: l2DisabledReason(exec.name) }
    }
    if (sessionId !== undefined && state.strikesOf(sessionId, exec.name) >= MAX_CONSECUTIVE_REJECTIONS) {
      return { kind: 'deny', reason: stopAndAskReason(exec.name) }
    }
    return next()
  }, { prepend: true })

  // Front of the approval answerer chain: grade, serve grant hits, delegate
  // the rest to the interactive answerer, and track rejection streaks.
  ctx.on('approval/request', async (req, next): Promise<ApprovalOutcome> => {
    const level = riskLevelOf(req.toolName)
    if (level === 'L2') return 'rejected'
    const sessionId: SessionId = req.agent.session.id
    if (state.hasGrant(sessionId, req.toolName)) return 'allowed-once'
    const outcome = await next()
    if (outcome === 'rejected') {
      state.addStrike(sessionId, req.toolName)
    } else if (outcome === 'allowed-once') {
      state.clearStrikesFor(sessionId, req.toolName)
    }
    return outcome
  }, { prepend: true })

  // One run (turn) = one clean rejection streak; session disposal drops all
  // session state (grants die with the session per SR-01).
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') state.clearStrikes(session.id)
  })
  ctx.on('session/disposed', (session) => {
    state.dropSession(session.id)
  })

  registerGrantsApi(ctx, state)
}
