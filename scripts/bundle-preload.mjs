/**
 * Bundles the main window's preload into ONE file with no runtime
 * `require()` besides `electron`:
 *
 *   electron/preload.ts -> dist-electron/electron/preload.js
 *
 * The main window is sandboxed (ADR-0001, later change), and a sandboxed
 * preload may only `require` a handful of built-ins — never a sibling file.
 * `tsc` emits `preload.js` with `require('../shared/ipc-api')`, which would
 * fail to run there and leave `window.dreyApi` undefined. This step runs
 * after `tsc` and replaces that file with the bundle; tsc stays the
 * typecheck, esbuild only inlines.
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(repoRoot, 'electron', 'preload.ts')],
  outfile: path.join(repoRoot, 'dist-electron', 'electron', 'preload.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'warning',
});
