/**
 * Run-timeline E2E (S5-7, A7; PRD FR-08/FR-02): the read-only timeline tab of
 * a finished run — run chip, FR-02 Run 摘要 (goal / result / tool stats /
 * duration), the executed tool row, and the single-run Markdown export
 * handed to the browser download seam with complete content.
 *
 * The task deliberately avoids generative-UI surfaces (no tab auto-opens), so
 * the start-door guide capsule — the user-reachable entry — is exercised.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { awaitTurns, newSession, openRunTimeline, send, skipWithoutTarget, TARGET, watchErrors, WORKSPACE } from './helpers.ts'

/** In-workspace scratch dir: inside the sandbox's workspace-write root. */
const SCRATCH = join(WORKSPACE, 'hibuddy-e2e', 'run-timeline')

test.beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true })
})

test.afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

test('run timeline: summary, tool row, and Markdown export', async ({ page }) => {
  skipWithoutTarget(test)
  const { errors, detach } = watchErrors(page)
  test.setTimeout(600_000)

  await page.goto(TARGET)
  await expect(page).toHaveTitle(/HiBuddy/)
  await newSession(page)

  const note = join(SCRATCH, 'e2e-timeline-note.txt')
  await send(page, `请用文件写入工具创建文件 ${note}，内容为 "timeline e2e note"。写完用一句话确认即可。`)
  await awaitTurns(page, 1)

  await openRunTimeline(page)
  const tab = page.locator('[data-hibuddy-run-timeline-tab]')
  await expect(tab).toBeVisible()
  await expect(tab).toContainText('Turn 1')

  // FR-02 Run 摘要: goal, result, tool statistics, duration.
  const summary = tab.locator('[data-hibuddy-run-summary]')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('目标')
  await expect(summary).toContainText('timeline e2e note')
  await expect(summary).toContainText('工具调用统计')
  await expect(summary).toContainText('耗时')

  // The executed tool row settled successfully.
  const toolRow = tab.locator('[data-hibuddy-run-tool]').first()
  await expect(toolRow).toBeVisible()
  await expect(toolRow).toContainText('完成')

  // Export: browser download seam with a stamped filename and full content.
  const downloadPromise = page.waitForEvent('download')
  await tab.getByRole('button', { name: '导出 Markdown' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^hibuddy-run-\d+-\d{8}-\d{6}\.md$/)
  const markdown = readFileSync(await download.path(), 'utf8')
  expect(markdown).toContain('# HiBuddy Run 记录 — Turn 1')
  expect(markdown).toContain('## 摘要')
  expect(markdown).toContain('## 时间线')
  expect(markdown).toContain('timeline e2e note')
  expect(markdown).toContain('**工具调用**')

  detach()
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([])
})
