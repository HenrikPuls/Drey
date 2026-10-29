#!/usr/bin/env node
/**
 * `npm test` wrapper around `ng test` with a compat shim for the legacy
 * Karma flag `--browsers`.
 *
 * The unit-test builder has been vitest-based (@angular/build:unit-test,
 * jsdom, headless by design) since Karma was removed. Old muscle memory --
 * and the tickets pipeline's phase prompt -- still invoke
 * `npm test -- --watch=false --browsers=ChromeHeadless`. vitest reads
 * `--browsers` as browser mode and exits demanding an uninstallable
 * `@vitest/browser-*` provider, so the fossil flag would fail a gate the
 * suite itself passes. The wrapper drops that flag (loudly, on stderr)
 * and forwards every other argument verbatim to `ng test`; the exit code
 * is the real suite's.
 *
 * Run via `npm test [-- <ng-test args...>]`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const forwarded = [];
let droppedBrowsers = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--browsers') {
    // Karma's space-separated form: the value is the next argument.
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
    droppedBrowsers = true;
  } else if (arg.startsWith('--browsers=')) {
    droppedBrowsers = true;
  } else {
    forwarded.push(arg);
  }
}

if (droppedBrowsers) {
  console.error(
    'note: --browsers is a legacy Karma flag; Karma is gone and the unit-test builder runs vitest in jsdom (headless) -- flag ignored',
  );
}

const result = spawnSync(
  process.execPath,
  [path.join('node_modules', '@angular', 'cli', 'bin', 'ng.js'), 'test', ...forwarded],
  { stdio: 'inherit', cwd: repoRoot },
);
process.exit(result.status ?? 1);
