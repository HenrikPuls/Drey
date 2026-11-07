/**
 * The out-of-Angular spec runner. `ng test` (the Angular `unit-test`
 * builder) constructs its own vitest config rooted at `src/` and silently
 * ignores every other spec entry in angular.json — these specs never ran
 * there. They are pure TypeScript with fake/injected APIs (no Angular, no
 * DOM, no Electron runtime), so they run here under plain Node against the
 * sources in `plugins/`, `electron/` and `shared/`.
 *
 * Run via `npm run test:plugins` (or directly:
 * `node node_modules/vitest/vitest.mjs run --config vitest.plugins.config.mts`).
 */
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * Worker cap. vitest's default is one worker per core; on a 32-core box
 * that is 32 files at once, a good share of them spawning real git / dk
 * processes (Windows process creation is the scarce resource, not CPU).
 * Oversubscribed, a 1-4 s real-git spec crossed the 5 s default and
 * temp-dir cleanups raced slow children (docs/testing-flakes.md); with
 * the cap the whole suite is both green under overlap and faster.
 */
// Cap 4, not 8 (req-145, owner 2026-11-07): the suite runs beside other sessions'
// gates and builds on one machine, and each worker holds a few hundred MB (JSDOM,
// the engine specs' processes); eight of them per session is what exhausted the RAM.
const maxWorkers = Math.max(2, Math.min(4, Math.floor(availableParallelism() / 4)));

/**
 * Specs that spawn real git / dk / node processes (a single test is 1-5 s
 * on Windows, idle). Their 5 s default measured how busy the machine was,
 * not whether the code works, so this group states its own budget; a hung
 * test still fails, a minute later. Everything else keeps the default.
 */
const PROCESS_SPECS = ['packages/**/*.spec.ts', 'plugins/git/**/*.spec.ts'];

export default defineConfig({
  test: {
    maxWorkers,
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'processes',
          environment: 'node',
          include: PROCESS_SPECS,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'units',
          environment: 'node',
          include: ['plugins/**/*.spec.ts', 'electron/**/*.spec.ts', 'shared/**/*.spec.ts', 'e2e/fixtures/**/*.spec.ts'],
          exclude: ['plugins/git/**/*.spec.ts', '**/node_modules/**'],
        },
      },
    ],
  },
});
