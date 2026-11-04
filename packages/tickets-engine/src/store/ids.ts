/**
 * Id mapping between Drey's display ids and dricket's (OD-1): prefix `t`,
 * numbers preserved — `T-0063` <-> `t-63`. Branches and worktree folders keep
 * the display form (`t/T-0063`), so only the store boundary maps.
 *
 * A dricket id with another prefix is not a Drey ticket; it passes through
 * lower-case so it stays visible instead of vanishing.
 */

const DISPLAY = /^T-(\d{1,})$/;
const DRICKET = /^t-([1-9]\d*)$/;

/** `T-0063` -> `t-63`; null when `id` is not a display id. */
export function toDricketId(id: string): string | null {
  const m = DISPLAY.exec(id.trim());
  if (m === null) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 ? `t-${n}` : null;
}

/** `t-63` -> `T-0063` (padded to four digits, wider numbers keep all digits); foreign ids pass through. */
export function toDisplayId(dricketId: string): string {
  const m = DRICKET.exec(dricketId.trim().toLowerCase());
  return m === null ? dricketId.trim().toLowerCase() : `T-${m[1]!.padStart(4, '0')}`;
}

export function isDisplayId(id: string): boolean {
  return toDricketId(id) !== null;
}
