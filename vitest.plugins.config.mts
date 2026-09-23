/**
 * The PLUGIN spec runner. `ng test` (the Angular `unit-test` builder)
 * constructs its own vitest config rooted at `src/` and silently ignores
 * the plugins spec entry in angular.json — these specs never ran there.
 * They are pure TypeScript with a fake plugin API (no Angular, no DOM),
 * so they run here under plain Node against the sources in `plugins/`
 * and `shared/`.
 *
 * Run via `npm run test:plugins` (or directly:
 * `node node_modules/vitest/vitest.mjs run --config vitest.plugins.config.mts`).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['plugins/**/*.spec.ts'],
    globals: true,
  },
});
