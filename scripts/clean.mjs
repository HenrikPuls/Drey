/**
 * Wipes the build output folders before a fresh build / pack.
 *
 * `fs.rmSync` alone is enough on a quiet machine, but `release/` is
 * routinely still half-locked for a moment right after a packaged
 * `drey.exe` closes, or while an AV / Explorer preview holds a handle --
 * which surfaced as an `EPERM` / "directory not empty" that aborted the
 * whole `pack:dir`. So each folder gets a few retries with a short back-off,
 * and a final failure on `release/` is swallowed: electron-builder recreates
 * and overwrites it anyway, whereas `dist/` and `dist-electron/` feed `tsc`
 * / the bundler and a stale one there must still be a hard error.
 */
import { rmSync } from 'node:fs';

const TARGETS = [
  { dir: 'dist', tolerateFailure: false },
  { dir: 'dist-electron', tolerateFailure: false },
  { dir: 'release', tolerateFailure: true },
];

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 200;

/** Busy-wait; `clean` is a one-shot build script, no event loop to keep free. */
function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin
  }
}

for (const { dir, tolerateFailure } of TARGETS) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        sleep(BACKOFF_MS * attempt);
      }
    }
  }
  if (lastError) {
    if (tolerateFailure) {
      console.warn(`clean: could not remove ${dir}/ (${lastError.code ?? lastError.message}); continuing`);
    } else {
      throw lastError;
    }
  }
}
