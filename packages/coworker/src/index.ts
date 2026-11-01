/**
 * HiBuddy coworker core plugin — host half (skeleton).
 *
 * Composition loads end-to-end with this empty body; registrations land here
 * as the first features are implemented:
 * - built-in tools via ctx.tools.register (inject the tools service first)
 * - approval risk grading via the approval/request waterfall answerer
 *   (fail-closed; L0 auto-allow / L1-L2 suspend per PRD SR-01)
 * - persona/preset defaults via profile patch config on this row
 *
 * References (thirdparty/deepseek-harness, read-only):
 * docs/user/develop/basic/tool.md, packages/interaction/user-approval/README.md
 */
export function apply(): void {}
