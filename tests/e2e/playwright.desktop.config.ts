/**
 * Playwright config for the HiBuddy desktop E2E (@hibuddy/e2e, Electron
 * driver). Unlike the web config, no external target is needed: the suite
 * spawns the @hibuddy/desktop-shell dev app itself and reads the RunAsNode
 * host's authenticated URL from its shell.log (see spec/desktop.spec.ts).
 *
 *   pnpm --filter @hibuddy/e2e test:desktop
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'spec',
  testMatch: /desktop\.spec\.ts$/,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
  },
})
