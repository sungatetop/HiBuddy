/**
 * Contract tests for the run plan decision (implementation-plan S3b task 5:
 * resume 优先). A history-echoing AG-UI client re-POSTs the whole transcript on
 * resume — pinning planRun keeps the S3b-4 regression (answered resume must not
 * replay the last user text as a fresh followup) from ever reappearing.
 */
import { describe, expect, it } from 'vitest'
import { planRun } from './index.ts'

describe('planRun（resume 优先决策）', () => {
  it('continues the suspended turn when the resume was answered, even with a user text riding along', () => {
    // The S3b-4 fix: history-echoing clients carry the last user message on
    // every POST — an answered resume must not fork a duplicate turn.
    expect(planRun(1, '再来一个')).toEqual({ action: 'continue-suspended' })
    expect(planRun(1, undefined)).toEqual({ action: 'continue-suspended' })
  })

  it('starts an ordinary run when there was nothing to resume', () => {
    expect(planRun(0, '你好')).toEqual({ action: 'start-run', userText: '你好' })
  })

  it('ends the run honestly when a resume answers nothing and carries no user text', () => {
    expect(planRun(0, undefined)).toEqual({ action: 'dead-resume' })
  })
})
