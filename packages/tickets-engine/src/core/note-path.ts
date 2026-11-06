/**
 * Which vault paths the Notes API (req-100) may touch: one pure rule, applied
 * to what a device sends and again to what the path really resolves to.
 *
 * Refused: anything that is not a plain `a/b/c` path (no `..`, no absolute
 * path, no backslash), names Windows would silently rewrite or read as a
 * stream or device (`chats./`, `note.md:x`, `NUL.md`), every dot-folder
 * (`.drafts/`, `.git/`), the assistant's `chats/` and every `tickets/` folder:
 * a ticket file changes through the board, never as a note.
 */
import { CHATS_DIR } from '../../../../shared/structural-folders';

const TICKETS_FOLDER = 'tickets';
const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
const WINDOWS_ILLEGAL = /[<>:"|?*\\/\x00-\x1f]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const NOTE_FILE = /\.md$/i;

function servedSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment.length <= MAX_SEGMENT_LENGTH &&
    !segment.startsWith('.') &&
    !segment.endsWith('.') &&
    !segment.endsWith(' ') &&
    !WINDOWS_ILLEGAL.test(segment) &&
    !WINDOWS_DEVICE.test(segment) &&
    segment.toLowerCase() !== TICKETS_FOLDER
  );
}

/** A folder or note below the vault root that the API serves. Root itself is the empty string. */
export function isServedPath(rel: string): boolean {
  if (rel === '') {
    return true;
  }
  if (rel.length > MAX_PATH_LENGTH) {
    return false;
  }
  const segments = rel.split('/');
  return segments.every(servedSegment) && segments[0]!.toLowerCase() !== CHATS_DIR;
}

/** The client's note path when the API serves it; null otherwise. */
export function parseNotePath(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' && NOTE_FILE.test(raw) && isServedPath(raw) ? raw : null;
}

/** The client's folder path ('' or absent = the root) when the API serves it; null otherwise. */
export function parseNoteFolder(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return '';
  }
  return typeof raw === 'string' && isServedPath(raw) ? raw : null;
}

/** A directory entry worth showing in a listing or scanning in a search. */
export function isServedChild(parent: string, name: string): boolean {
  return isServedPath(parent === '' ? name : `${parent}/${name}`);
}

export function isNoteFileName(name: string): boolean {
  return NOTE_FILE.test(name);
}
