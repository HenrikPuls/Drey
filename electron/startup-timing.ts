import { logLine } from './logger';

/**
 * Startup-phase timing marks (milestone 61). One line per mark in the
 * ADR-0032 log file: `+delta` since the previous mark and the total since
 * process start (`performance.now()` is anchored near process launch in
 * the main process). Lines are written immediately, not buffered, so a
 * boot that dies mid-way still leaves its trace. Renderer phases log
 * their own `[startup/renderer]` lines on their own clock (ms since
 * navigation start) — the two totals are not comparable with each other.
 *
 * Always on: the whole point is comparing packaged cold/warm starts, and
 * a handful of lines per session is far below the log's 1 MB cap.
 */

let last = performance.now();

/** Records one startup phase boundary in the log file. */
export function startupMark(label: string): void {
  const now = performance.now();
  logLine(`[startup] ${label} +${Math.round(now - last)}ms (total ${Math.round(now)}ms)`);
  last = now;
}
