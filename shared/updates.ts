/**
 * Pure helpers of the in-app update system (milestone 82, ADR-0074):
 * release-version parsing/comparison and the "skip this version" rule.
 * electron-updater decides whether a release is offered; these decide
 * what Drey tells the user about it. No Electron imports — shared by
 * both sides of the IPC boundary and covered by plain unit tests.
 */

/** Where Drey's releases live — also the manual-download fallback. */
export const RELEASES_PAGE_URL = 'https://github.com/HenrikPuls/Drey/releases';

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * A release version as Drey writes it (`0.6.0`, tolerated with a leading
 * `v`), as `[major, minor, patch]`. Anything else (a stray tag name, an
 * empty string) is `null` — callers treat it as "not newer".
 */
export function parseVersion(raw: string): [number, number, number] | null {
  const match = VERSION_RE.exec(raw.trim());
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether `candidate` is strictly newer than `current`. Malformed input
 * is never newer — a bad tag on a release must not nag the user.
 */
export function isNewerVersion(current: string, candidate: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(candidate);
  if (a === null || b === null) {
    return false;
  }
  return (
    b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) || (b[0] === a[0] && b[1] === a[1] && b[2] > a[2])
  );
}

/**
 * Whether the startup prompt stays silent: the user answered "Skip this
 * version" for exactly this version. A later version asks again; a manual
 * check (Settings, Help menu) always reports.
 */
export function isVersionSkipped(available: string, skipped: string | null): boolean {
  return skipped !== null && available === skipped;
}
