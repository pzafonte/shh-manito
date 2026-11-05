import { defineConfig, devices } from '@playwright/test';

const E2E_ORIGIN = 'http://127.0.0.1:3210';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.ts',
  // Every spec shares one server and its clock.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: E2E_ORIGIN,
    ...devices['iPhone 14'],
    defaultBrowserType: 'chromium',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec tsx tests/e2e/server.ts',
    url: `${E2E_ORIGIN}/healthz`,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
