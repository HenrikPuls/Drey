import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A tiny append-only log file under the OS user-data dir
 * (`<userData>/logs/drey.log`). The packaged build has no open DevTools, so
 * this is the only way a field problem -- e.g. the app-wide input lock the
 * project owner hit -- leaves a trace. Kept deliberately minimal: no levels
 * filter, no async queue, best-effort writes that never throw into a caller.
 *
 * The file is size-capped: once it passes ~1 MB it is rotated to
 * `drey.log.1` (a single previous generation) so it can't grow without
 * bound on a long-lived install.
 */

const MAX_BYTES = 1_000_000;

let logFilePath: string | null = null;

function ensurePath(): string | null {
  if (logFilePath) {
    return logFilePath;
  }
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, 'drey.log');
    return logFilePath;
  } catch {
    return null;
  }
}

function rotateIfLarge(file: string): void {
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // no file yet, or the rename lost a race -- either way, carry on.
  }
}

/** Appends one line, prefixed with an ISO timestamp. Never throws. */
export function logLine(message: string): void {
  const file = ensurePath();
  if (!file) {
    return;
  }
  rotateIfLarge(file);
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // A locked / unwritable log file must not take the app down.
  }
}

/** Records a renderer-sourced entry (`app:log` IPC). `context` is JSON-stringified. */
export function logFromRenderer(
  level: string,
  message: string,
  context?: unknown,
): void {
  const suffix = context === undefined ? '' : ` ${safeJson(context)}`;
  logLine(`[renderer/${level}] ${message}${suffix}`);
}

/** Wires main-process crash / rejection hooks to the log file. Call once at startup. */
export function installMainProcessLogging(): void {
  logLine('[main] --- session start ---');
  process.on('uncaughtException', (err) => {
    logLine(`[main/uncaughtException] ${err?.stack ?? String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    logLine(
      `[main/unhandledRejection] ${
        reason instanceof Error ? (reason.stack ?? reason.message) : safeJson(reason)
      }`,
    );
  });
}

/** Attaches renderer-process failure hooks to a window's `webContents`. */
export function watchWebContents(webContents: Electron.WebContents): void {
  webContents.on('render-process-gone', (_e, details) => {
    logLine(`[main/render-process-gone] ${safeJson(details)}`);
  });
  webContents.on('unresponsive', () => logLine('[main/unresponsive] renderer stopped responding'));
  webContents.on('responsive', () => logLine('[main/responsive] renderer recovered'));
  webContents.on('preload-error', (_e, preloadPath, error) => {
    logLine(`[main/preload-error] ${preloadPath}: ${error?.stack ?? String(error)}`);
  });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
