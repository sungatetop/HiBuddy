/**
 * Butler-layer generative-UI E2E (genui-agui-optimization.md P2/P3 acceptance,
 * G2/G3/G4) against a live dsh web server:
 *
 *  1. G4 — the butler chat renders `kind='ui'` ledger attachments inline:
 *     a chart bubble and a form bubble, each fetching its instruction JSON
 *     from `/resident/api/ui-instruction` on mount (the ledger only rides the
 *     reference).
 *  2. G2 — a form send-back travels as one structured `@[ui:<id>:<revision>]`
 *     text through the SAME chat channel; the pump's host-side revision gate
 *     passes the current revision and the butler turn completes.
 *  3. G1/G3 — an update ask bumps the persisted revision (latest served as 2,
 *     historical revision 1 still fetchable = 历史版本可回看); the old bubble
 *     keeps its stale surface and its submit is rejected with a visible
 *     notice and NO model turn.
 *
 * The model is real (deepseek route), so turn timings vary; every wait polls
 * the UI, never the clock. Turn completion syncs on the butler "处理中" bar
 * disappearing (the ledger UI has no native turn tails). Instruction ids are
 * run-unique so ledger history from earlier runs cannot alias the assertions.
 *
 * One serial test: the steps share the butler's single conversation.
 */
import { expect, test } from '@playwright/test'
import { skipWithoutTarget, TARGET, watchErrors } from './helpers.ts'

const COMPOSER = 'textarea[placeholder="给管家发消息…"]'
const PROCESSING = '管家正在处理…'
const STALE_NOTICE = '该界面已更新或已不存在，刚才的操作未生效。'

test('butler generative UI: bubble render, gated send-back, revision history', async ({ page }) => {
  skipWithoutTarget(test)
  const { errors, detach } = watchErrors(page)
  test.setTimeout(600_000)

  await page.goto(TARGET)
  await expect(page).toHaveTitle(/HiBuddy/)

  // Open the butler chat panel (the sidebar entry) and get its composer.
  await page.getByRole('button', { name: '管家' }).first().click()
  const composer = page.locator(COMPOSER)
  await expect(composer).toBeVisible()

  // Send one message and sync on the pump finishing the turn: the bar appears
  // optimistically on submit and disappears when the poll sees the butler idle.
  const send = async (text: string): Promise<void> => {
    await composer.fill(text)
    await composer.press('Enter')
    await expect(page.getByText(PROCESSING).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(PROCESSING).first()).toBeHidden({ timeout: 240_000 })
  }

  const run = Date.now().toString(36)
  const chartId = `butler-genui-e2e-${run}-chart`
  const formId = `butler-genui-e2e-${run}-form`

  // --- G4: chart bubble renders inline through the trusted registry. -------
  await send([
    '请用 render_ui 工具生成一个图表，调用参数照抄以下 JSON（props/data 原样使用，不要改结构）：',
    `{"id":"${chartId}","target":"inline","component":"chart",`,
    '"props":{"chartType":"bar","xKey":"month","series":[{"key":"value","label":"支出"}]},',
    '"data":{"items":[{"month":"一月","value":120},{"month":"二月","value":90},{"month":"三月","value":160}]},',
    '"provenance":"示例数据（非本轮工具结果）","summary":"近三月支出柱状图"}',
  ].join(''))
  const chartBubble = page
    .locator('[data-hibuddy-genui-component="chart"]', { hasText: '近三月支出柱状图' })
    .last()
  await expect(chartBubble).toBeVisible({ timeout: 30_000 })
  await expect(chartBubble.locator('svg[role="img"]')).toBeVisible()
  await expect(chartBubble.locator('.hg-provenance')).toContainText('示例数据')

  // --- G3: the reference route serves the instruction; unknown ids 404. ----
  const latestChart = await page.evaluate(async (id) => {
    const response = await fetch(`/resident/api/ui-instruction?id=${id}`)
    return { status: response.status, body: await response.json() }
  }, chartId)
  expect(latestChart.status).toBe(200)
  expect(latestChart.body.component).toBe('chart')
  const missing = await page.evaluate(async () => {
    const response = await fetch('/resident/api/ui-instruction?id=butler-genui-e2e-missing')
    return response.status
  })
  expect(missing).toBe(404)

  // --- G4: form bubble renders; fill + submit → structured envelope text. --
  const formFields = [
    '{"id":"name","label":"姓名","type":"text","required":true},',
    '{"id":"rating","label":"评分","type":"select","required":true,"options":["1 星","2 星","3 星","4 星","5 星"]},',
    '{"id":"agree","label":"同意条款","type":"checkbox","required":true}',
  ].join('')
  await send([
    '请用 render_ui 工具生成一个反馈表单，调用参数照抄以下 JSON（props 原样使用，不要改数组形状）：',
    `{"id":"${formId}","target":"inline","component":"form",`,
    `"props":{"fields":[${formFields}],"submitLabel":"提交"},`,
    '"summary":"反馈表单：姓名、评分与同意条款"}',
  ].join(''))
  const form = page
    .locator('[data-hibuddy-genui-component="form"]', { hasText: '反馈表单：姓名、评分与同意条款' })
    .last()
    .locator('form[data-hibuddy-genui-surface="form"]')
  await expect(form).toBeVisible({ timeout: 30_000 })

  // The ledger persists across runs, so earlier runs' stale notices stay
  // visible forever — assert on the DELTA around this run's actions.
  const notices = page.getByText(STALE_NOTICE)
  const noticeBaseline = await notices.count()

  await form.locator('input[type="text"]').fill('王五')
  await form.locator('select').selectOption('5 星')
  await form.locator('input[type="checkbox"]').check()
  await form.locator('button').click()
  // The envelope rides the chat channel as a literal user bubble (G2).
  await expect(page.getByText(`@[ui:${formId}:1]`).first()).toBeVisible({ timeout: 15_000 })
  await expect(form.locator('pre')).toContainText('王五', { timeout: 15_000 })
  // Current revision passes the gate: the butler actually turns (bar + reply),
  // and no NEW stale notice appears.
  await expect(page.getByText(PROCESSING).first()).toBeHidden({ timeout: 240_000 })
  await expect(notices).toHaveCount(noticeBaseline)

  // --- G1/G3: an update ask bumps the persisted revision. ------------------
  await send([
    '请用 render_ui 工具更新反馈表单（id 不变，revision 会自动 +1），调用参数照抄以下 JSON：',
    `{"id":"${formId}","target":"inline","component":"form",`,
    `"props":{"fields":[${formFields}],"submitLabel":"重新提交"},`,
    '"summary":"反馈表单 v2：提交按钮文案更新"}',
  ].join(''))

  const revisions = await page.evaluate(async (id) => {
    const latest = await fetch(`/resident/api/ui-instruction?id=${id}`)
    const first = await fetch(`/resident/api/ui-instruction?id=${id}&revision=1`)
    return {
      latestStatus: latest.status,
      latest: await latest.json(),
      firstStatus: first.status,
      first: await first.json(),
    }
  }, formId)
  expect(revisions.latestStatus).toBe(200)
  expect(revisions.latest.revision).toBe(2)
  expect(revisions.latest.props.submitLabel).toBe('重新提交')
  // 历史版本可回看：revision 1 is still served with the original props.
  expect(revisions.firstStatus).toBe(200)
  expect(revisions.first.revision).toBe(1)
  expect(revisions.first.props.submitLabel).toBe('提交')

  // --- G2: the stale bubble (still showing revision 1) rejects its submit --
  // with a visible notice and NO model turn (the pump never wakes). The
  // surface state may have been reset by ledger re-renders, so refill first —
  // a real user on a stale panel would do the same.
  await form.locator('input[type="text"]').fill('王五')
  await form.locator('select').selectOption('5 星')
  await form.locator('input[type="checkbox"]').check()
  await form.locator('button').click()
  await expect(page.getByText(`@[ui:${formId}:1]`)).toHaveCount(2, { timeout: 15_000 })
  await expect(notices).toHaveCount(noticeBaseline + 1, { timeout: 15_000 })
  await expect(page.getByText(PROCESSING).first()).toBeHidden({ timeout: 15_000 })

  detach()
  // The deliberate missing-id probe (G3 404 check) logs one resource-load
  // error by design; any other console/page error fails the spec.
  expect(errors.filter((error) => !error.includes('404')), `console/page errors: ${errors.join(' | ')}`).toEqual([])
})
