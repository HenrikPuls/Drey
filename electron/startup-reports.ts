import { app, dialog, type BrowserWindow } from 'electron';
import * as path from 'node:path';
import type { LostSecrets } from './app-config';
import { logFileLocation, logLine } from './logger';
import type { UnreadableFile } from './safe-file';

/**
 * The native dialogs that tell the user something went wrong in the main
 * process: an error nothing caught, and what a start could not read.
 * Each takes the main window to attach to, or null when there is none.
 */

function showMessage(owner: BrowserWindow | null, options: Electron.MessageBoxOptions) {
  const alive = owner !== null && !owner.isDestroyed() ? owner : null;
  return alive ? dialog.showMessageBox(alive, options) : dialog.showMessageBox(options);
}

let mainProcessErrorReported = false;

/**
 * Tells the user once per session that the main process threw an error
 * nothing caught. Registering the `uncaughtException` listener (for the
 * log) switched Electron's own dialog off; without this the app would carry
 * on silently in a state nobody checked.
 */
export function reportMainProcessError(err: Error, owner: BrowserWindow | null): void {
  if (mainProcessErrorReported) {
    return;
  }
  mainProcessErrorReported = true;
  const logFile = logFileLocation();
  const detail =
    'The app may not behave correctly until it is restarted. Save your work and restart Drey.' +
    `\n\n${err.message}` +
    (logFile === null ? '' : `\n\nDetails are in the log file:\n${logFile}`);
  if (!app.isReady()) {
    dialog.showErrorBox('Drey ran into an unexpected error', detail);
    return;
  }
  const shown = showMessage(owner, {
    type: 'error',
    title: 'Drey',
    message: 'Drey ran into an unexpected error',
    detail,
    buttons: ['Quit Drey', 'Keep running'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  void shown.then(({ response }) => {
    if (response === 0) {
      // Through the usual exit path, so unsaved documents are still asked about.
      app.quit();
    }
  });
}

/**
 * Tells the user which stored settings files could not be used at this
 * start. Each was set aside by its store (`safe-file.ts`); the app runs on
 * defaults for it.
 */
export function reportUnreadableConfigFiles(
  problems: readonly UnreadableFile[],
  owner: BrowserWindow | null,
): void {
  if (problems.length === 0) {
    return;
  }
  for (const problem of problems) {
    logLine(
      `[startup] unreadable ${problem.filePath} (${problem.reason}); kept as ${
        problem.backupPath ?? 'nothing -- it could not be copied'
      }`,
    );
  }
  const lines = problems.map((problem) =>
    problem.backupPath === null
      ? `${path.basename(problem.filePath)} (could not be kept)`
      : `${path.basename(problem.filePath)} — kept as ${problem.backupPath}`,
  );
  void showMessage(owner, {
    type: 'warning',
    title: 'Drey',
    message:
      problems.length === 1
        ? 'A settings file could not be read'
        : 'Some settings files could not be read',
    detail:
      'Drey started with defaults instead. Your notes are not affected; a vault that is ' +
      'missing from the Files panel can be added again.\n\n' +
      lines.join('\n'),
    buttons: ['OK'],
    noLink: true,
  });
}

/**
 * Tells the user once which stored keys could not be decrypted at startup
 * -- they are empty now and have to be entered again.
 */
export function reportLostSecrets(lost: LostSecrets | null, owner: BrowserWindow | null): void {
  if (lost === null) {
    return;
  }
  logLine(
    `[startup] ${lost.labels.length} stored secret(s) could not be decrypted; file kept as ${
      lost.backupPath ?? 'nothing -- it could not be copied'
    }`,
  );
  void showMessage(owner, {
    type: 'warning',
    title: 'Drey',
    message:
      lost.labels.length === 1
        ? 'A stored key could not be decrypted'
        : 'Some stored keys could not be decrypted',
    detail:
      'Keys in the settings file are encrypted for this user account on ' +
      'this computer. They are empty now -- enter them again in Settings:\n\n' +
      lost.labels.join('\n') +
      (lost.backupPath === null ? '' : `\n\nThe previous file was kept as ${lost.backupPath}`),
    buttons: ['OK'],
    noLink: true,
  });
}
