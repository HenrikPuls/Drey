import { defineConfig } from '@playwright/test';

/**
 * Playwright drives the *built* Electron app end-to-end (main + preload +
 * renderer + IPC), not the renderer in a stock browser -- almost every
 * flow in Drey crosses the `contextBridge` boundary, so a browser-only
 * harness would test very little of it.
 *
 * Prerequisite: `dist-electron/` and `dist/drey/browser/` must be current.
 * `npm run e2e` runs `npm run build` first; `npm run e2e:run` assumes you
 * already have a fresh build (faster inner loop). There is deliberately no
 * `webServer` block -- tests load the production renderer from disk via the
 * `app://` scheme, so `ng serve` is not involved.
 */
export default defineConfig({
  testDir: './e2e',
  // The Electron app takes the single-instance lock (electron/main.ts). Each
  // launch gets its own `--user-data-dir`, so the lock does not collide
  // across parallel workers, but keeping it serial makes failures far easier
  // to read while the suite is small. Raise later if it matters.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  // Electron cold-start is a few seconds on top of the actual assertions.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI']
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
