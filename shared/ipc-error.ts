/**
 * Turns an error that came back across the IPC bridge into something worth
 * showing a user.
 *
 * Electron re-throws a main-process failure in the renderer wrapped in its
 * own plumbing: an error whose message reads
 *
 *     Error invoking remote method 'thread:summarize': Error: No model is
 *     selected in settings.
 *
 * The useful half is the last clause; the rest names an IPC channel the
 * user has no idea about and cannot act on. This strips the wrapper and any
 * repeated `Error:` prefixes, and leaves anything that isn't shaped like
 * that untouched.
 *
 * Pure, and in `shared/` because the message text is the one thing both
 * sides of the boundary have an opinion about.
 */

const REMOTE_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_PREFIX = /^(?:[A-Za-z]*Error):\s*/;

export function ipcErrorMessage(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  text = text.replace(REMOTE_WRAPPER, '');
  // A wrapped error can carry several `Error:` prefixes stacked up.
  let previous: string;
  do {
    previous = text;
    text = text.replace(ERROR_PREFIX, '');
  } while (text !== previous);
  return text.trim() || 'Something went wrong.';
}
