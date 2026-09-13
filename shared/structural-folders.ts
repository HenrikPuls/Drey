/**
 * The vault's structural folder conventions in one place (see
 * `specs/frontmatter-schema.md`): folders the APP imposes, as opposed to
 * the user's own topic folders. Pure path predicates — no fs, shared by
 * main and renderer.
 *
 * - `templates/` — note templates; excluded from the tag index.
 * - `daily/` — one note per day (`shared/daily.ts` owns its grammar).
 * - `chats/` — assistant conversation notes (ADR-0048); indexed like
 *   `daily/`, and auto-saved: the chat engine appends every turn to the
 *   file itself, so an open tab follows the disk instead of holding an
 *   independent unsaved buffer (no save prompts, no exit prompt).
 * - `.drafts/` — the hidden folder where untitled scratch buffers commit
 *   at exit (bug-5); a dot-folder, invisible to tree and indexes. Files
 *   there are temp files — auto-saved and never prompted about.
 */

export const CHATS_DIR = 'chats';
export const DRAFTS_DIR = '.drafts';

/** True when `path` lives under the assistant's `chats/` folder. */
export function isChatNotePath(path: string): boolean {
  return path === CHATS_DIR || path.startsWith(`${CHATS_DIR}/`);
}

/** True when `path` lives under the hidden `.drafts/` folder. */
export function isDraftPath(path: string): boolean {
  return path === DRAFTS_DIR || path.startsWith(`${DRAFTS_DIR}/`);
}

/**
 * True when edits to `path` are saved automatically instead of waiting for
 * Ctrl+S: app-generated, app-owned files (chat notes, committed drafts).
 * Never true for an `askOnSave` scratch tab — its "save" would open the
 * Save-As dialog, which is exactly the prompt auto-save must not produce.
 */
export function isAutoSavePath(path: string): boolean {
  return isChatNotePath(path) || isDraftPath(path);
}
