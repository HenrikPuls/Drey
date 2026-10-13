// Mirrors docs/manual/ -> public/manual/: the in-app user manual the Help
// menu opens (ADR "In-app help documents"). Angular copies `public/**`
// verbatim into dist/drey/browser/, and the app:// protocol serves that
// folder in the packaged app -- so the manual ships with zero
// electron-builder changes.
//
// Runs as part of the `prebuild` hook (like licenses:generate) and via
// `predev` before `ng serve`, so a shipped build can never carry a stale
// manual. The copy is a plain mirror -- except that `{{MANUAL_VERSION}}`
// and `{{MANUAL_GENERATED}}` in Markdown files are substituted, so the
// manual's footer states the app version and the manual's own generation
// date without anyone hand-editing them (the "Drey 0.3.0" drift). Files
// removed from docs/manual are removed here too, and the result is
// byte-stable (a re-run with an unchanged source produces no git noise):
// the version comes from package.json, and the generation date is the
// day the manual's content last changed in git -- both are deterministic,
// unlike a build-time stamp, which would dirty the committed mirror on
// every new day's first build.
//
// public/manual/ is committed on purpose (same convention as
// src/assets/licenses.json): a fresh clone builds without regenerating
// anything first, and this script only re-syncs on change.

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
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

// The footer stamp (roadmap "Manual stamp"): version straight from
// package.json, generation date = the day docs/manual last changed in
// git. A hard-coded version in the source is what drifted before, so the
// build fails loudly if the token is missing from manual.md.
const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const manualSrc = readFileSync(join(srcDir, 'manual.md'), 'utf8');
if (!manualSrc.includes('{{MANUAL_VERSION}}')) {
  console.error(
    '[manual:sync] docs/manual/manual.md lost its {{MANUAL_VERSION}} token -- ' +
      'the footer version must come from the build, never hand-edited',
  );
  process.exit(1);
}

/** The manual's generation date: git's last content change, `YYYY-MM-DD`. */
function manualGenerationDate() {
  try {
    const date = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', 'docs/manual'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return date;
    }
  } catch {
    // No git (an exported tree): byte-stability is moot there anyway.
  }
  return new Date().toISOString().slice(0, 10);
}

const substitutions = {
  '{{MANUAL_VERSION}}': version,
  '{{MANUAL_GENERATED}}': manualGenerationDate(),
};

/** @param {string} content @returns {string} */
function stamp(content) {
  return content.replaceAll('{{MANUAL_VERSION}}', substitutions['{{MANUAL_VERSION}}']).replaceAll(
    '{{MANUAL_GENERATED}}',
    substitutions['{{MANUAL_GENERATED}}'],
  );
}
// Mirror copy: always overwrite (git tracks content, not mtimes, so a
// re-run with an unchanged source produces no git noise). Markdown files
// go through the footer substitution; everything else (images, …) is
// copied verbatim.
const srcFiles = listFiles(srcDir);
mkdirSync(outDir, { recursive: true });
let copied = 0;
for (const src of srcFiles) {
  const dest = join(outDir, relative(srcDir, src));
  if (extname(src).toLowerCase() === '.md') {
    writeFileSync(dest, stamp(readFileSync(src, 'utf8')));
  } else {
    cpSync(src, dest);
  }
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

console.log(
  `[manual:sync] ${copied} file(s) mirrored docs/manual -> public/manual ` +
    `(${pruned} pruned, manual ${version} of ${substitutions['{{MANUAL_GENERATED}}']})`,
);
