/**
 * Approval-flow E2E (S5-7, A7; PRD FR-03): the three decisions of the HiBuddy
 * enhanced approval card against a live dsh web server — 批准 (approve one
 * call), 拒绝 (reject, the model adapts instead of erroring), and 本会话免再询
 * (session-scoped grant: the next same-tool ask in this session runs without
 * a card). The trigger is a write to an out-of-workspace path, which dsh's
 * policy escalates (S3 verified); the durable ground truth is the file on
 * disk, and the Run timeline joins the page-lifetime decision mirror by
 * callId.
 *
 * One serial test per decision, each in its own session (grants die with the
 * session per SR-01, so a shared session would leak a grant between tests).
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { approvalCard, awaitTurns, ESCALATE_NOW, newSession, openRunTimeline, send, skipWithoutTarget, TARGET, watchErrors } from './helpers.ts'

/** Scratch dir OUTSIDE the smoke workspace so writes escalate. */
const OUTSIDE = 'D:\\_tmp_hibuddy_e2e'

/** Prompt asking for one out-of-workspace file write (escalation on denial). */
function writePrompt(file: string, text: string): string {
  return `请用文件写入工具把一行文本 "${text}" 写入工作区外的文件 ${file}（D 盘根下的绝对路径，不在当前工作区内）。只写这一个文件，不要写其他位置。${ESCALATE_NOW}`
}

test.beforeAll(() => {
  mkdirSync(OUTSIDE, { recursive: true })
})

test.afterAll(() => {
  rmSync(OUTSIDE, { recursive: true, force: true })
})

test('approval: approve lets the write through and joins the timeline', async ({ page }) => {
  skipWithoutTarget(test)
  const { errors, detach } = watchErrors(page)
  test.setTimeout(600_000)

  await page.goto(TARGET)
  await expect(page).toHaveTitle(/HiBuddy/)
  await newSession(page)

  const file = `${OUTSIDE}\\approve.txt`
  await send(page, writePrompt(file, 'hibuddy e2e approve'))

  // The enhanced card: full card chrome plus the three decision buttons.
  const card = approvalCard(page)
  await expect(card).toBeVisible({ timeout: 240_000 })
  await expect(card.getByRole('button', { name: '批准' })).toBeVisible()
  await expect(card.getByRole('button', { name: '本会话免再询' })).toBeVisible()

  await card.getByRole('button', { name: '批准' }).click()
  // Ground truth: the write executed only after the approval.
  await expect.poll(() => {
    try { return readFileSync(file, 'utf8') } catch { return '' }
  }, { timeout: 240_000 }).toContain('hibuddy e2e approve')
  await awaitTurns(page, 1)

  // The page-lifetime decision mirror joins the run timeline by callId.
  await openRunTimeline(page)
  const tab = page.locator('[data-hibuddy-run-timeline-tab]')
  await expect(tab).toBeVisible()
  await expect(tab.locator('[data-hibuddy-run-tool]').filter({ hasText: '已批准' })).toHaveCount(1, { timeout: 30_000 })

  detach()
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([])
})

test('approval: reject returns the reason to the model and the write never lands', async ({ page }) => {
  skipWithoutTarget(test)
  const { errors, detach } = watchErrors(page)
  test.setTimeout(600_000)

  await page.goto(TARGET)
  await expect(page).toHaveTitle(/HiBuddy/)
  await newSession(page)

  const file = `${OUTSIDE}\\reject.txt`
  await send(page, writePrompt(file, 'hibuddy e2e reject'))

  const card = approvalCard(page)
  await expect(card).toBeVisible({ timeout: 240_000 })
  await card.getByRole('button', { name: '拒绝' }).click()

  // The model may retry the same ask after a rejection; keep rejecting. The
  // stop-and-ask gate (3 consecutive rejections) terminates such loops by
  // design, so this loop is bounded; 20s without a new card means the turn
  // settled without a retry.
  for (let i = 0; i < 3; i++) {
    const pending = approvalCard(page)
    try {
      await pending.waitFor({ state: 'visible', timeout: 20_000 })
    } catch {
      break
    }
    await pending.getByRole('button', { name: '拒绝' }).click()
  }
  await awaitTurns(page, 1)
  expect(existsSync(file), 'rejected write must not land').toBe(false)

  detach()
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([])
})

test('approval: session waiver answers later same-tool asks without a card', async ({ page }) => {
  skipWithoutTarget(test)
  const { errors, detach } = watchErrors(page)
  test.setTimeout(600_000)

  await page.goto(TARGET)
  await expect(page).toHaveTitle(/HiBuddy/)
  await newSession(page)

  // First write: escalate, waive for the session.
  const first = `${OUTSIDE}\\waive-a.txt`
  await send(page, writePrompt(first, 'hibuddy e2e waive a'))
  const card = approvalCard(page)
  await expect(card).toBeVisible({ timeout: 240_000 })
  await card.getByRole('button', { name: '本会话免再询' }).click()
  await expect.poll(() => {
    try { return readFileSync(first, 'utf8') } catch { return '' }
  }, { timeout: 240_000 }).toContain('hibuddy e2e waive a')
  await awaitTurns(page, 1)

  // Second write, same session same tool: the grant answers it — the file
  // lands with no pending card ever appearing (an unanswered card would keep
  // the run interrupted, so file existence is itself the channel proof).
  const second = `${OUTSIDE}\\waive-b.txt`
  await send(page, writePrompt(second, 'hibuddy e2e waive b'))
  await awaitTurns(page, 2)
  await expect.poll(() => {
    try { return readFileSync(second, 'utf8') } catch { return '' }
  }, { timeout: 240_000 }).toContain('hibuddy e2e waive b')
  await expect(approvalCard(page)).toHaveCount(0)

  detach()
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([])
})
