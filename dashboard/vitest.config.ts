import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest, for the slice of the dashboard that is NOT a Server Component.
//
// Most pages here are `async` Server Components — they fetch on the server and render once, and
// there is no honest way to drive one in jsdom. Those are covered by Playwright against a real
// render (see TESTING.md). What jsdom IS good for is the handful of `'use client'` components
// that hold real browser-side logic, plus the React-key check below, which needs a DEVELOPMENT
// React build — something a production Playwright run can never give us.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // ⚠️ The Playwright specs are also `*.spec.ts`. Without this, Vitest would collect them,
    // fail on the missing Playwright fixtures, and the failure would look like a broken suite
    // rather than a misconfigured runner.
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
});
