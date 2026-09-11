/**
 * Small pure formatters the assistant panel needs at runtime. Copies of the
 * app's `shared/duration.ts`, `shared/timestamp.ts` (only `formatDateTime`)
 * and `shared/ipc-error.ts` — a plugin renderer is served as plain ES
 * modules over `plugin://` and cannot import the app's `shared/` files at
 * runtime (they only exist as CJS under `dist-electron/shared`), so each
 * plugin carries the handful of helpers it needs (ADR-0044; the meeting
 * plugin's `timestamp.ts` copy is the precedent).
 */

/** `8s`, `59s`, `1m 04s`, `12m 30s`. Sub-second rounds up to `1s`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** What the panel shows next to a finished card: `took 8s`. */
export function formatTook(ms: number): string {
  return `took ${formatDuration(ms)}`;
}

/** What the panel shows while a task is still running: `thinking 8s`. */
export function formatThinking(ms: number): string {
  return `thinking ${formatDuration(ms)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `2026-09-05T14:32:00` — a card's `at` stamp (ISO local). */
export function formatDateTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

const REMOTE_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_PREFIX = /^(?:[A-Za-z]*Error):\s*/;

/** Turns an IPC-transported error into something worth showing a user. */
export function ipcErrorMessage(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  text = text.replace(REMOTE_WRAPPER, '');
  let previous: string;
  do {
    previous = text;
    text = text.replace(ERROR_PREFIX, '');
  } while (text !== previous);
  return text.trim() || 'Something went wrong.';
}
