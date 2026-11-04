/**
 * Playwright config for the HiBuddy E2E suite (@hibuddy/e2e).
 *
 * The target is a LIVE dsh web server (real runtime + real model), NOT a
 * spawned one: point `HIBUDDY_E2E_URL` at the smoke server URL including its
 * `?token=` query (the server's access token is not guessable, so the suite
 * never runs against an unintended target). Example:
 *
 *   pnpm smoke serve   # or any running `dsh --profile hibuddy` web server
 *   HIBUDDY_E2E_URL="http://127.0.0.1:3080/?token=…" pnpm --filter @hibuddy/e2e test
 */
import { defineConfig } from '@playwright/test'

const baseURL = process.env.HIBUDDY_E2E_URL

if (baseURL === undefined || baseURL === '') {
  console.warn(
    '[hibuddy-e2e] HIBUDDY_E2E_URL is not set — the suite will fail fast. '
    + 'Point it at a live dsh web server URL including the ?token= query.',
  )
}

export default defineConfig({
  testDir: 'spec',
  // The desktop suite (Electron driver) manages its own lifecycle and target:
  // run it through playwright.desktop.config.ts (`pnpm --filter @hibuddy/e2e test:desktop`).
  testIgnore: '**/desktop.spec.ts',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
})
