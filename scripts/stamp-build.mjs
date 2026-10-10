// Writes src/assets/build-info.json: the unique, monotonically increasing
// build identity the "About" settings pane shows. Runs as part of the
// `prebuild` hook (and `dev:electron`) so every shipped build carries a
// distinct number -- the project owner keeps earlier builds in testing and
// needs to tell them apart.
//
// buildNumber = `git rev-list --count HEAD` -- strictly monotonic, no
// counter file to maintain, unique per commit. `commit` is the short SHA
// (disambiguates local uncommitted builds at the same count) and `builtAt`
// is the wall-clock build time. `branch` and `checkoutPath` identify the
// checkout the build ran in -- in a linked git worktree the branch reads
// `worktree/<name>`, which is what the native window title suffixes so
// concurrent dev instances are told apart in the taskbar. When git is
// unavailable (a source tarball, a broken PATH) the file is still written
// with a 0 / "unknown" fallback so the pane has something to render.
//
// The file is gitignored on purpose: unlike licenses.json it is NOT
// byte-stable (the number grows, the timestamp moves), so committing it
// would be pure noise.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(repoRoot, 'src/assets/build-info.json');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

let buildNumber = 0;
let commit = 'unknown';
let branch = 'unknown';
let checkoutPath = 'unknown';
try {
  buildNumber = Number.parseInt(git(['rev-list', '--count', 'HEAD']), 10) || 0;
  commit = git(['rev-parse', '--short', 'HEAD']);
  branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  checkoutPath = git(['rev-parse', '--show-toplevel']);
  // Mark a dirty working tree so a hand-built local package is not mistaken
  // for the exact committed state.
  const dirty = git(['status', '--porcelain']).length > 0;
  if (dirty) {
    commit += '+';
  }
} catch (err) {
  console.warn('[stamp:build] git unavailable, writing fallback build-info:', err.message);
}

const payload = {
  buildNumber,
  commit,
  branch,
  checkoutPath,
  builtAt: new Date().toISOString(),
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`[stamp:build] build ${buildNumber} (${commit}) -> ${outFile}`);
