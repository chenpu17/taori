import { defineConfig, devices } from '@playwright/test';

// Standalone config — no sidecar, no global-setup, targets mock-only dev server
export default defineConfig({
  testDir: './e2e',
  testMatch: 'multi-model.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3456',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
