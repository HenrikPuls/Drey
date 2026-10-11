// Mirrors docs/manual/ -> public/manual/: the in-app user manual the Help
// menu opens (ADR "In-app help documents"). Angular copies `public/**`
// verbatim into dist/drey/browser/, and the app:// protocol serves that
// folder in the packaged app -- so the manual ships with zero
// electron-builder changes.
//
// Runs as part of the `prebuild` hook (like licenses:generate) and via
// `predev` before `ng serve`, so a shipped build can never carry a stale
// manual. The copy is a plain mirror: files removed from docs/manual are
// removed here too, and the result is byte-stable (a re-run with an
// unchanged source produces no git noise).
//
// public/manual/ is committed on purpose (same convention as
// src/assets/licenses.json): a fresh clone builds without regenerating
// anything first, and this script only re-syncs on change.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(repoRoot, 'docs/manual');
const outDir = resolve(repoRoot, 'public/manual');

if (!existsSync(join(srcDir, 'manual.md'))) {
  console.error(`[manual:sync] source manual not found: ${join(srcDir, 'manual.md')}`);
  process.exit(1);
}

/** @param {string} dir @returns {string[]} */
function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

// Mirror copy: always overwrite (git tracks content, not mtimes, so a
// re-run with an unchanged source produces no git noise).
const srcFiles = listFiles(srcDir);
mkdirSync(outDir, { recursive: true });
let copied = 0;
for (const src of srcFiles) {
  const dest = join(outDir, relative(srcDir, src));
  cpSync(src, dest);
  copied += 1;
}

// Prune stale outputs (renamed or deleted manual files must not linger).
let pruned = 0;
if (existsSync(outDir)) {
  const srcSet = new Set(srcFiles.map((f) => relative(srcDir, f)));
  for (const dest of listFiles(outDir)) {
    const rel = relative(outDir, dest);
    if (!srcSet.has(rel)) {
      rmSync(dest);
      pruned += 1;
    }
  }
}

console.log(`[manual:sync] ${copied} file(s) mirrored docs/manual -> public/manual (${pruned} pruned)`);
