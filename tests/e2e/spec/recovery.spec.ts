/**
 * Abnormality-injection E2E (S5-7, A7/A3; PRD FR-09): in-progress runs survive
 * transport and page disruptions.
 *
 * 1. Disconnect: the dsh host process is suspended for 30 seconds (the S5-4
 *    simulation — NtSuspendProcess freezes the whole server; TCP stays open,
 *    SSE stalls), then resumed. The in-flight run keeps progressing: every
 *    file the multi-step task writes lands, and the turn settles.
 * 2. Page reopen: a run started, the page is reloaded mid-run, and the turn
 *    still completes — the reloaded client re-derives state from durable
 *    history (the Run-timeline tab rebuilds from the event window).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { awaitTurns, newSession, openRunTimeline, send, skipWithoutTarget, TARGET, watchErrors, WORKSPACE } from './helpers.ts'

/** In-workspace scratch dir: inside the sandbox's workspace-write root. */
const SCRATCH = join(WORKSPACE, 'hibuddy-e2e')

/** Freeze/resume a process via ntdll (S5-4 disconnect simulation). */
const PS_FREEZE = [
  "$env:LIB=''; $env:LIBX=''",
  "Add-Type -Name Nt -Namespace Win -MemberDefinition '[DllImport(\"ntdll.dll\")] public static extern uint NtSuspendProcess(System.IntPtr handle); [DllImport(\"ntdll.dll\")] public static extern uint NtResumeProcess(System.IntPtr handle);'",
  '$p = Get-Process -Id __PID__ -ErrorAction Stop',
  "$r = if ('__ACTION__' -eq 'suspend') { [Win.Nt]::NtSuspendProcess($p.Handle) } else { [Win.Nt]::NtResumeProcess($p.Handle) }",
  "Write-Output ('ntstatus=0x' + $r.ToString('X8'))",
].join('; ')

function freeze(pid: number, action: 'suspend' | 'resume'): void {
  const script = PS_FREEZE.replace('__PID__', String(pid)).replace('__ACTION__', action)
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0 || !result.stdout.includes('ntstatus=0x0')) {
    throw new Error(`freeze ${action} pid=${pid} failed: ${result.stdout} ${result.stderr}`)
  }
}

/** PID of the process listening on the target's port (the dsh host). */
function hostPidOf(target: string): number {
  const port = new URL(target).port
  if (port === '') throw new Error(`target URL has no port: ${target}`)
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess`],
    { encoding: 'utf8', timeout: 30_000 },
  )
  const pid = Number.parseInt(result.stdout.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`no listener on port ${port}: ${result.stdout} ${result.stderr}`)
  }
  return pid
}

test.beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true })
})

test.afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

test('disconnect 30s: the in-flight run keeps progressing after host freeze/resume', async ({ page }) => {
  skipWithoutTarget(test)
  const { errors, detach } = watchErrors(page)
  test.setTimeout(600_000)

  await page.goto(TARGET)
  await expect(page).toHaveTitle(/HiBuddy/)
  await newSession(page)

  // Three sequential writes keep the run busy well past the freeze window.
  const files = ['a', 'b', 'c'].map((n) => join(SCRATCH, `freeze-${n}.txt`))
  await send(page, [
    `请依次完成三步，每步写一个文件（用文件写入工具，路径都在工作区内）：`,
    `1) 创建 ${files[0]} 内容 "alpha"；2) 创建 ${files[1]} 内容 "beta"；3) 创建 ${files[2]} 内容 "gamma"。`,
    `三步全部完成后用一句话汇报。`,
  ].join(''))

  // Freeze the host mid-run for 30 seconds, then let everything continue.
  const pid = hostPidOf(TARGET)
  freeze(pid, 'suspend')
  await page.waitForTimeout(30_000)
  freeze(pid, 'resume')

  // The run was not lost: every write landed and the turn settled.
  await awaitTurns(page, 1)
  for (const file of files) {
    await expect.poll(() => existsSync(file), { timeout: 60_000 }).toBe(true)
  }

  detach()
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([])
})

test('page reopen mid-run: the run completes and the timeline rebuilds', async ({ page }) => {
  skipWithoutTarget(test)
  const { errors, detach } = watchErrors(page)
  test.setTimeout(600_000)

  await page.goto(TARGET)
  await expect(page).toHaveTitle(/HiBuddy/)
  await newSession(page)

  const files = [join(SCRATCH, 'reload-a.txt'), join(SCRATCH, 'reload-b.txt'), join(SCRATCH, 'reload-c.txt')]
  await send(page, [
    `请依次完成三步（用文件写入工具，路径在工作区内）：`,
    `1) 创建 ${files[0]} 内容 "one"；2) 创建 ${files[1]} 内容 "two"；3) 创建 ${files[2]} 内容 "three"。`,
    `三步完成后用一句话汇报。`,
  ].join(''))

  // Reopen the page while the run is in flight (the run continues server-side).
  await page.waitForTimeout(3_000)
  await page.reload()
  await expect(page).toHaveTitle(/HiBuddy/)

  // Turn tails replay with the rebuilt conversation, so poll for at least one
  // finished turn instead of an exact count.
  await expect.poll(
    () => page.getByRole('button', { name: /已完成，用时/ }).count(),
    { timeout: 240_000 },
  ).toBeGreaterThanOrEqual(1)
  for (const file of files) {
    await expect.poll(() => existsSync(file), { timeout: 60_000 }).toBe(true)
  }

  // The reloaded client rebuilds the run from durable history.
  await openRunTimeline(page)
  const tab = page.locator('[data-hibuddy-run-timeline-tab]')
  await expect(tab).toBeVisible()
  await expect(tab).toContainText('Turn 1')

  detach()
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([])
})
