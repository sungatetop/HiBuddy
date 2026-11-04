/**
 * Generative-UI basic flow E2E (S4-6, A7): the full ADR-007 loop against a
 * live dsh web server — canvas form render, structured interaction send-back,
 * model acknowledgment, shared-state agent write, and the user's panel edit
 * relayed back through the model — ending with a clean console assertion.
 *
 * The model is real (MiniMax smoke route), so turn timings vary; every wait
 * polls the UI, never the clock. Turn completion syncs on the native
 * "已完成，用时 N 秒" tail disclosure (one per finished turn), which no client
 * state can shortcut: envelopes and optimistic writes appear immediately, but
 * a turn tail only lands after the model actually answered.
 *
 * One serial test: the steps share one session.
 */
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'

/** The live smoke URL including its ?token= query (baseURL drops queries). */
const TARGET = process.env.HIBUDDY_E2E_URL ?? ''

/** Console errors and page errors collected from the page under test. */
function watchErrors(page: Page): { errors: string[], detach: () => void } {
  const errors: string[] = []
  const onConsole = (message: ConsoleMessage): void => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  }
  const onPageError = (error: Error): void => {
    errors.push(`pageerror: ${error.message}`)
  }
  page.on('console', onConsole)
  page.on('pageerror', onPageError)
  return { errors, detach: () => { page.off('console', onConsole); page.off('pageerror', onPageError) } }
}

/** Type one message into the composer and send it with Enter. */
async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await expect(composer).toBeVisible()
  await composer.click()
  // Playwright fill is the only reliable clear+type for the Lexical composer.
  await composer.fill(text)
  await composer.press('Enter')
  await expect(composer).toHaveText('', { timeout: 15_000 })
}

/** Wait until at least `count` turns have fully completed on this page. */
async function awaitTurns(page: Page, count: number): Promise<void> {
  // One tail button per finished turn ("已完成，用时 N 秒"); text-based
  // matching is ambiguous here (each tail nests 4 text-bearing elements).
  await expect(page.getByRole('button', { name: /已完成，用时/ })).toHaveCount(count, { timeout: 240_000 })
}

test('generative UI basic flow: canvas form, send-back, shared state', async ({ page }) => {
  test.skip(TARGET === '', 'HIBUDDY_E2E_URL is not set')
  const { errors, detach } = watchErrors(page)
  test.setTimeout(600_000)

  await page.goto(TARGET)
  await expect(page).toHaveTitle(/HiBuddy/)

  // Fresh session so the flow starts from an empty conversation.
  await page.getByRole('button', { name: '新建会话' }).first().click()

  // --- A2/A3: canvas form render (the model names component+fields). -------
  // The props are spelled as a literal JSON snippet: MiniMax-M2.7 sometimes
  // emits proto-style {"item":[...]} array wrappers from prose field lists,
  // which the trusted form component then rejects into the static fallback.
  await send(page, [
    '请用 render_ui 工具（target 用 canvas）生成一个反馈表单，调用参数照抄以下 JSON（props 原样使用，不要改数组形状）：',
    '{"id":"feedback-e2e","target":"canvas","title":"反馈表单","component":"form",',
    '"props":{"fields":[{"id":"name","label":"姓名","type":"text","required":true},',
    '{"id":"rating","label":"评分","type":"select","required":true,"options":["1 星","2 星","3 星","4 星","5 星"]},',
    '{"id":"agree","label":"同意条款","type":"checkbox","required":true}],"submitLabel":"提交"},',
    '"summary":"反馈表单：姓名、评分与同意条款。"}',
  ].join(''))
  const form = page.locator('form[data-hibuddy-genui-surface="form"]')
  await expect(form).toBeVisible({ timeout: 240_000 })
  await awaitTurns(page, 1)

  // --- A4: fill + submit → structured envelope → model acknowledgment. -----
  await form.locator('input[type="text"]').fill('王五')
  await form.locator('select').selectOption('5 星')
  await form.locator('input[type="checkbox"]').check()
  await form.locator('button').click()
  await expect(form.locator('pre')).toContainText('王五', { timeout: 15_000 })
  await expect(page.getByText('[generative-ui interaction]').first()).toBeVisible({ timeout: 30_000 })
  // The model reads the queued envelope next round; the second turn's tail is
  // the only signal that it actually answered (the envelope text alone would
  // match immediately and prove nothing). Citing 王五 in the reply is model
  // behavior, already verified in the manual smoke — the channel proof is the
  // completed turn itself.
  await awaitTurns(page, 2)

  // --- A6 (agent half): shared_state write → panel auto-reveal. ------------
  await send(page, '请用 shared_state 工具写入共享状态：key 为 todo，value 为 "整理季度报告数据"，source 用 agent。只写这一个键。')
  const row = page.locator('[data-hibuddy-shared-state-row="todo"]')
  // The row only exists after the model's settled tool call is fed to the
  // panel store — an optimistic write cannot shortcut it (none happened yet).
  await expect(row).toBeVisible({ timeout: 240_000 })
  await expect(row).toContainText('整理季度报告数据')
  await expect(row).toContainText('agent')
  await awaitTurns(page, 3)

  // --- A6 (user half): panel edit → optimistic entry → envelope → relay. ---
  const panel = page.locator('[data-hibuddy-shared-state-tab]')
  await panel.locator('input').nth(0).fill('todo')
  await panel.locator('input').nth(1).fill('整理季度报告数据 v2')
  await panel.locator('button').click()
  // Optimistic write lands immediately with the user source badge.
  await expect(row).toContainText('整理季度报告数据 v2', { timeout: 15_000 })
  await expect(row).toContainText('user')
  // The relay envelope goes up as a queued turn; wait for the model to answer.
  await expect(page.getByText('[shared-state update]').first()).toBeVisible({ timeout: 30_000 })
  await awaitTurns(page, 4)

  // Reload: optimistic entries are page-lifetime only, so what survives must
  // come from the persisted tool calls — the model really relayed the edit.
  await page.reload()
  await expect(page).toHaveTitle(/HiBuddy/)
  await expect(page.locator('[data-hibuddy-shared-state-row="todo"]')).toContainText('整理季度报告数据 v2', { timeout: 60_000 })
  await expect(page.locator('[data-hibuddy-shared-state-row="todo"]')).toContainText('user')

  detach()
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([])
})
