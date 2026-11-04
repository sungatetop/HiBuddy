/**
 * Shared helpers for the HiBuddy E2E specs (live dsh web server, real model).
 *
 * Every wait polls the UI, never the clock. Turn completion syncs on the
 * native "已完成，用时 N 秒" tail disclosure (one per finished turn), which no
 * client state can shortcut: envelopes and optimistic writes appear
 * immediately, but a turn tail only lands after the model actually answered.
 */
import { expect, type ConsoleMessage, type Page } from '@playwright/test'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The live smoke URL including its ?token= query (baseURL drops queries). */
export const TARGET = process.env.HIBUDDY_E2E_URL ?? ''

/**
 * The session workspace of the live smoke server: dsh's default workspace
 * (the sandbox's workspace-write root). In-workspace scratch files must live
 * here to stay sandbox-allowed and be verifiable on disk; override with
 * HIBUDDY_E2E_WORKSPACE when the server runs with a custom workspace.
 */
export const WORKSPACE = process.env.HIBUDDY_E2E_WORKSPACE
  ?? join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace')

/**
 * Instruction appended to every out-of-workspace write ask: the sandbox
 * (workspace-write mode) denies the first attempt, and the approval card only
 * appears on the model's danger-full-access escalation retry — without this
 * clause the model may just explain the denial and ask instead (observed in
 * the first reject run), which never opens the card.
 */
export const ESCALATE_NOW = '如果写入被沙箱拒绝，直接发起升级重试（danger-full-access），不要先征求我的意见；升级重试最多一次。'

/** Console errors and page errors collected from the page under test. */
export function watchErrors(page: Page): { errors: string[], detach: () => void } {
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

/** Skip guard for suites that need a live target. */
export function skipWithoutTarget(test: { skip: (condition: boolean, description: string) => void }): void {
  test.skip(TARGET === '', 'HIBUDDY_E2E_URL is not set')
}

/** Type one message into the composer and send it with Enter. */
export async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first()
  await expect(composer).toBeVisible()
  await composer.click()
  // Playwright fill is the only reliable clear+type for the Lexical composer.
  await composer.fill(text)
  await composer.press('Enter')
  await expect(composer).toHaveText('', { timeout: 15_000 })
}

/** Wait until at least `count` turns have fully completed on this page. */
export async function awaitTurns(page: Page, count: number): Promise<void> {
  // One tail button per finished turn ("已完成，用时 N 秒"); text-based
  // matching is ambiguous here (each tail nests 4 text-bearing elements).
  await expect(page.getByRole('button', { name: /已完成，用时/ })).toHaveCount(count, { timeout: 240_000 })
}

/** Start a fresh session so a flow runs from an empty conversation. */
export async function newSession(page: Page): Promise<void> {
  await page.getByRole('button', { name: '新建会话' }).first().click()
}

/**
 * Open the Run-timeline tab through its user entry (S5-2): open the right
 * sidebar if closed, then pick the start-door guide capsule. Only valid while
 * no other right-sidebar tab is open (the guide shows on the start door).
 */
export async function openRunTimeline(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: '打开右侧边栏' })
  if (await open.isVisible().catch(() => false)) await open.click()
  await page.getByText('Run 时间线').first().click()
}

/** The HiBuddy enhanced approval card; a pending card answers no call yet. */
export function approvalCard(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-hibuddy-approval][aria-busy="false"]')
}
