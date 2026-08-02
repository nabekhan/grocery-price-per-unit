import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'artifacts/traces',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-CA',
    timezoneId: 'UTC'
  },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }]
});
