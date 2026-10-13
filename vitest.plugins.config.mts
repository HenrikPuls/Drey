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
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['plugins/**/*.spec.ts', 'electron/**/*.spec.ts', 'shared/**/*.spec.ts'],
    globals: true,
  },
});
