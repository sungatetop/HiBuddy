/**
 * Desktop E2E (S5-7, A7; Electron driver): spawn the @hibuddy/desktop-shell
 * dev app, read the RunAsNode host's authenticated URL from its shell.log,
 * and drive the same dsh web bundle through the desktop parity path —
 * conversation, generative-UI form render + structured send-back (FR-04/05),
 * and the approval flow with a real out-of-workspace write (FR-03).
 *
 * The shell lifecycle lives in beforeAll/afterAll: graceful WM_CLOSE first
 * (the shell then tears the host child down), force-kill of the spawned tree
 * as the fallback. Console-error watch starts at goto, so no cross-run
 * residue is possible (unlike a shared MCP browser).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { approvalCard, awaitTurns, ESCALATE_NOW, newSession, send, watchErrors } from './helpers.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const shellLog = join(homedir(), 'AppData', 'Roaming', '@hibuddy', 'desktop-shell', 'shell.log')
/** Scratch dir OUTSIDE the smoke workspace so desktop writes escalate too. */
const OUTSIDE = 'D:\\_tmp_hibuddy_e2e'

/** WM_CLOSE to every Electron window, then force-kill the spawned tree. */
const PS_CLOSE = [
  "$env:LIB=''; $env:LIBX=''",
  "Add-Type -Name U -Namespace W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);'",
  'Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [W.U]::PostMessage($_.MainWindowHandle, 16, [IntPtr]::Zero, [IntPtr]::Zero) }',
  'Start-Sleep -Seconds 10',
].join('; ')

let shell: ChildProcess | undefined
let desktopUrl = ''

test.beforeAll(async () => {
  mkdirSync(OUTSIDE, { recursive: true })
  // Read the log incrementally: only lines appended after the spawn count.
  let offset = 0
  try { offset = statSync(shellLog).size } catch { /* first run */ }

  shell = spawn('pnpm', ['--filter', '@hibuddy/desktop-shell', 'start'], {
    cwd: repoRoot,
    shell: true,
    stdio: 'ignore',
  })

  const deadline = Date.now() + 150_000
  for (;;) {
    if (shell.exitCode !== null) throw new Error(`desktop shell exited early (code ${shell.exitCode})`)
    if (Date.now() > deadline) throw new Error('desktop host URL not found in shell.log within 150s')
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_000))
    try {
      const fresh = readFileSync(shellLog, 'utf8').slice(offset)
      const match = /host ready: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/.exec(fresh)
      if (match !== null) {
        desktopUrl = match[1]
        break
      }
    } catch { /* log not written yet */ }
  }
}, 180_000)

test.afterAll(async () => {
  spawnSync('powershell.exe', ['-NoProfile', '-Command', PS_CLOSE], { encoding: 'utf8', timeout: 30_000 })
  if (shell !== undefined && shell.pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(shell.pid), '/T', '/F'], { timeout: 30_000 })
  }
  rmSync(OUTSIDE, { recursive: true, force: true })
})

test('desktop: render_ui form flow and approval path through the Electron shell', async ({ page }) => {
  expect(desktopUrl, 'desktop host URL must be set by beforeAll').not.toBe('')
  const { errors, detach } = watchErrors(page)
  test.setTimeout(600_000)

  await page.goto(desktopUrl)
  await expect(page).toHaveTitle(/HiBuddy/)
  await newSession(page)

  // --- FR-04/05: canvas form render + structured send-back. ----------------
  await send(page, [
    '请用 render_ui 工具（target 用 canvas）生成一个反馈表单，调用参数照抄以下 JSON（props 原样使用，不要改数组形状）：',
    '{"id":"desktop-e2e","target":"canvas","title":"桌面反馈表单","component":"form",',
    '"props":{"fields":[{"id":"name","label":"姓名","type":"text","required":true},',
    '{"id":"rating","label":"评分","type":"select","required":true,"options":["1 星","2 星","3 星","4 星","5 星"]},',
    '{"id":"agree","label":"同意条款","type":"checkbox","required":true}],"submitLabel":"提交"},',
    '"summary":"桌面端反馈表单。"}',
  ].join(''))
  const form = page.locator('form[data-hibuddy-genui-surface="form"]')
  await expect(form).toBeVisible({ timeout: 240_000 })
  await awaitTurns(page, 1)

  await form.locator('input[type="text"]').fill('赵六')
  await form.locator('select').selectOption('5 星')
  await form.locator('input[type="checkbox"]').check()
  await form.locator('button').click()
  await expect(form.locator('pre')).toContainText('赵六', { timeout: 15_000 })
  await expect(page.getByText('[generative-ui interaction]').first()).toBeVisible({ timeout: 30_000 })
  await awaitTurns(page, 2)

  // --- FR-03: approval card + approve on the desktop host. -----------------
  const file = `${OUTSIDE}\\desktop-approve.txt`
  await send(page, `请用文件写入工具把一行文本 "hibuddy desktop e2e" 写入工作区外的文件 ${file}（D 盘根下的绝对路径，不在当前工作区内）。只写这一个文件。${ESCALATE_NOW}`)
  const card = approvalCard(page)
  await expect(card).toBeVisible({ timeout: 240_000 })
  await card.getByRole('button', { name: '批准' }).click()
  await expect.poll(() => {
    try { return readFileSync(file, 'utf8') } catch { return '' }
  }, { timeout: 240_000 }).toContain('hibuddy desktop e2e')
  await awaitTurns(page, 3)

  detach()
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([])
})
