/**
 * Tool risk grading (PRD FR-03 / SR-01; ADR-009 §2).
 *
 * dsh preset-standard already mounts the full official tool set and gates
 * sensitive operations through sandbox modes + escalation approvals; requests
 * only reach the `approval/request` waterfall when dsh's own policy says
 * "needs a decision". HiBuddy grades those requests:
 *
 * - L2 (code execution, external effect): denied by default. The primary gate
 *   is the `tools/pre-execute` deny below (with model-facing guidance); the
 *   `approval/request` answerer keeps a backstop rejection in case a request
 *   still escalates (e.g. sandbox-escape approval asks).
 * - L1 (everything else that escalates — out-of-workspace writes, …): requires
 *   per-session confirmation, with an optional "don't ask again this session"
 *   grant recorded by the web approval card via the grants API.
 * - L0 (reads / web fetches) never escalates in dsh, so it never reaches the
 *   answerer — auto-execute with native `tool/call` / `tool/result` audit.
 */

/** Levels that can reach the approval waterfall; L0 auto-executes upstream. */
export type RiskLevel = 'L1' | 'L2'

/** L2 = code execution tools (PRD FR-03: 默认关闭). */
export const L2_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])

/** FR-03 rule 2: after this many consecutive rejections in one run, stop and ask. */
export const MAX_CONSECUTIVE_REJECTIONS = 3

/** Grade a tool that reached the approval waterfall. */
export function riskLevelOf(toolName: string): RiskLevel {
  return L2_TOOLS.has(toolName) ? 'L2' : 'L1'
}

/** Model-facing guidance once a tool was rejected too many times in this run. */
export function stopAndAskReason(toolName: string): string {
  return (
    `用户已在本轮任务中连续 ${MAX_CONSECUTIVE_REJECTIONS} 次拒绝了工具 "${toolName}"。`
    + `不要再尝试调用该工具；请停下当前方案，直接向用户说明情况并询问接下来的意图（可使用 ask_user 工具）。`
  )
}

/** Model-facing guidance for L2 default-off rejections. */
export function l2DisabledReason(toolName: string): string {
  return (
    `工具 "${toolName}"（代码执行，L2 风险等级）默认关闭：HiBuddy 产品策略不允许执行 shell 命令。`
    + `请改用文件读写、网页读取等工具完成任务，或向用户说明该操作需要开启代码执行能力。`
  )
}
