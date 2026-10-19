#!/usr/bin/env node
/**
 * Scoped test runner for the out-of-Angular suite (vitest.plugins.config.mts).
 * `npm run test:plugin -- <id>` runs only the specs under plugins/<id>/ --
 * the daily loop while working on one plugin, instead of the whole
 * electron/ + shared/ + plugins/ suite. The full suite stays
 * `npm run test:plugins`; the release gate runs it via `npm run test:all`
 * (prepack, before `npm run pack`).
 *
 * The scope argument is either a plugin id (`tags`, `tickets`) or a path
 * fragment that vitest matches against the spec files (`shared`,
 * `electron/ipc`, `plugins/tags/main`). Anything after the scope is passed
 * through to vitest: `-t "rename"` for single tests, `--watch` for watch
 * mode. An unknown scope fails loudly with the available plugin ids -- a
 * typo would otherwise run nothing (vitest finds no files) or, with a
 * too-wide fragment, far too much.
 *
 * Run via `npm run test:plugin -- <id> [vitest args...]`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginIds = readdirSync(path.join(repoRoot, 'plugins'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const [scope, ...extra] = args.filter((arg) => arg !== '--watch');

if (!scope) {
  fail(
    `usage: npm run test:plugin -- <plugin-id | path-fragment> [vitest args...]\n` +
      `plugins: ${pluginIds.join(', ')}\n` +
      `(path fragments work too: shared, electron/ipc, plugins/tags/main)`,
  );
}

// A plugin id scopes to plugins/<id>; anything else must at least exist as
// a folder (or folder prefix) to pass through as a vitest filter.
let filter;
if (pluginIds.includes(scope)) {
  filter = `plugins/${scope}`;
} else if (existsSync(path.join(repoRoot, scope)) || existsSync(path.join(repoRoot, `plugins/${scope}`))) {
  filter = scope;
} else {
  fail(
    `no such scope "${scope}" -- plugins: ${pluginIds.join(', ')}\n` +
      `(path fragments work too: shared, electron/ipc, plugins/tags/main)`,
  );
}

const result = spawnSync(
  process.execPath,
  [
    path.join('node_modules', 'vitest', 'vitest.mjs'),
    watch ? 'watch' : 'run',
    '--config',
    'vitest.plugins.config.mts',
    filter,
    ...extra,
  ],
  { stdio: 'inherit', cwd: repoRoot },
);
process.exit(result.status ?? 1);
