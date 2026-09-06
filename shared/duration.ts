/**
 * How a generation's elapsed time is written in the UI.
 *
 * A local model can think for anything between a second and several
 * minutes, and the number is read at a glance next to a timestamp — so it
 * is short, never zero-padded on the leading unit, and never shows more
 * precision than the reader can use ("2m 05s", not "2m 5.371s").
 *
 * Pure, in `shared/` because the same value is written live by the panel
 * while a task runs and read back from a stored card afterwards.
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
