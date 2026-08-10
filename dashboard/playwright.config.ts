import { defineConfig, devices } from '@playwright/test';

// End-to-end smoke tests for the dashboard.
//
// ⭐ WHY E2E AND NOT JEST + REACT TESTING LIBRARY.
//
// Almost every page here is an `async` Server Component that fetches on the server and renders
// once. RTL has no good story for those — you end up mocking the fetch layer until the test is
// asserting your own mocks, which is a check that cannot fail. The seven `'use client'` components
// are unit-testable and two of them are worth it, but that is a small slice of the app.
//
// For a mostly-SSR application the honest unit of verification is a rendered page, so these run
// against a real deployment: real API, real Postgres, real corpus.
//
// ⚠️ THE TRADE, STATED: these are NOT hermetic. They need something running, and a failure can
// mean "the API is down" rather than "the code is wrong". That is accepted deliberately — the
// alternative for SSR pages is a mock-shaped test that passes whether or not the page works. The
// suite is a smoke/regression net, not a substitute for the 105 offline unit tests in `api/`.
//
// Target is configurable; defaults to production.
//   npx playwright test
//   BASE_URL=http://localhost:3000 npx playwright test

export default defineConfig({
  testDir: './e2e',
  // Serial by default: this hits a single `t3.small` running the API, and hammering it with
  // parallel workers would measure the box rather than the code.
  workers: 1,
  fullyParallel: false,
  // Fail the run if someone leaves a .only in — a suite that silently runs one test is a suite
  // that reports green while covering nothing.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 45_000,
  expect: {
    // The API is a cold-startable box behind an ingress; first byte can be slow.
    timeout: 15_000,
  },
  use: {
    baseURL: process.env.BASE_URL ?? 'https://omwanalytics.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
