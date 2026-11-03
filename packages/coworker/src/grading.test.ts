/**
 * Contract tests for tool risk grading (implementation-plan S3 task 5:
 * 分级规则). The grading table is the product's FR-03/SR-01 posture — these
 * tests pin it so a tool-name drift (upstream rename, new official tool)
 * fails loudly here instead of silently re-grading at runtime.
 */
import { describe, expect, it } from 'vitest'
import {
  L2_TOOLS, MAX_CONSECUTIVE_REJECTIONS, l2DisabledReason, riskLevelOf, stopAndAskReason,
} from './grading.ts'

describe('riskLevelOf（分级规则）', () => {
  it('grades code-execution tools L2（默认关闭）', () => {
    expect(riskLevelOf('bash')).toBe('L2')
    expect(riskLevelOf('pwsh')).toBe('L2')
  })

  it('grades every other escalating tool L1（需确认）', () => {
    for (const toolName of ['write', 'edit', 'str_replace_editor', 'web_fetch', 'todo_write', 'unknown-future-tool']) {
      expect(riskLevelOf(toolName), toolName).toBe('L1')
    }
  })

  it('keeps the L2 set exactly {bash, pwsh}（新增工具须显式评审）', () => {
    expect([...L2_TOOLS].sort()).toEqual(['bash', 'pwsh'])
  })
})

describe('MAX_CONSECUTIVE_REJECTIONS（FR-03 规则 2）', () => {
  it('is 3 consecutive rejections per run', () => {
    expect(MAX_CONSECUTIVE_REJECTIONS).toBe(3)
  })
})

describe('model-facing rejection guidance', () => {
  it('l2DisabledReason names the tool and states default-off with an alternative', () => {
    const reason = l2DisabledReason('bash')
    expect(reason).toContain('bash')
    expect(reason).toContain('默认关闭')
    expect(reason).toContain('不允许执行 shell')
    expect(reason).toContain('向用户说明')
  })

  it('stopAndAskReason names the tool, the count, and the ask-the-user action', () => {
    const reason = stopAndAskReason('write')
    expect(reason).toContain('write')
    expect(reason).toContain('3')
    expect(reason).toContain('询问')
  })
})
