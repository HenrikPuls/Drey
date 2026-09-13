/**
 * The ask contract between the assistant panel (renderer) and the chat
 * engine (main), ADR-0048: one `AskRequest` with the note context
 * (nullable — the note chip can be deselected), reference-only extra
 * files, image paths, and the chat note to continue (`null` = create a
 * new one). There is NO `history` field any more — the engine replays
 * the full persisted chat note itself (the bug-10(b) resolution); the
 * old field and its interim validation (bug-10(a), milestone 23) are
 * deleted with it.
 *
 * Lives in the plugin's `shared/` like `chat-note.ts`: imported by both
 * of its consumers. Runtime-self-contained (type-only app-shared
 * imports).
 */
import type { AskOutcome } from '../../../shared/llm';

/** One file attached to an ask turn. `body` is the document text (LF). */
export interface AskFile {
  path: string;
  body: string;
}

/**
 * One ask turn. `note: null` means the note chip is deselected: there is
 * no document to edit, so the turn is answer-only (the engine picks the
 * matching system prompt and ignores an `edit` reply) — a zero-context
 * standalone chat is legitimate now. `images` are vault-relative image
 * paths: they persist as attachment links in the note and ride the call
 * as vision parts when the provider supports them.
 *
 * `liveEdit` opts THIS turn into immediate-apply editing (ADR-0049): the
 * model edits `note` directly through the doc tools, each change lands in
 * the editor as it happens, nothing is confirmed. Requires `note !== null`
 * and only ever travels true for a live-editable target (the renderer
 * clamps it — never a `chats/`/`.drafts/` auto-save path).
 */
export interface AskRequest {
  question: string;
  /** The open note with its live buffer, or `null` when the chip is off. */
  note: AskFile | null;
  /** Reference-only attachments; never an edit target. */
  extraFiles: AskFile[];
  /** Vault-relative image paths attached to THIS turn. */
  images: string[];
  /** The chat note to continue, or `null` to start a new one. */
  chatPath: string | null;
  /** Immediate-apply editing for this turn (ADR-0049). */
  liveEdit: boolean;
  /**
   * The focused document's doc key (`vaultId::relativePath`) at send time —
   * the new chat's `note:` binding (req: the panel follows the active
   * document). Independent of the note chip: even a chat with the chip off
   * belongs to the workspace it was started in. `null` when nothing
   * text-shaped is focused or the tab carries no vaultId (scratch).
   */
  noteKey: string | null;
}

/**
 * The result of a live-edit ask turn (ADR-0049): the changes are already
 * applied — to the open tab (pushed per tool call) and to the chat note
 * (the turn's applied `edit` entry). `applied` counts the applied hunks /
 * whole-document replacements, `text` is the model's summary (or a
 * fallback when the model produced none).
 */
export interface LiveEditOutcome {
  kind: 'liveEdit';
  path: string;
  applied: number;
  text: string;
}

/** Everything the renderer's `ask` port can come back with. */
export type AssistantOutcome = AskOutcome | LiveEditOutcome;

/** Cap on attached files per ask turn (the composer enforces it, too). */
export const MAX_EXTRA_FILES = 10;

/** Cap on attached images per ask turn (vision models choke on more). */
export const MAX_IMAGES = 4;

/**
 * Per-file body cap (~25k tokens): enough for any real note, small enough
 * that a mis-added file cannot blow a local model's context window. The
 * note body itself is never truncated — it is the edit target.
 */
export const MAX_FILE_CHARS = 100_000;

/** Marks a truncated body so the model (and the user) can tell. */
export function truncateFileBody(body: string): string {
  if (body.length <= MAX_FILE_CHARS) {
    return body;
  }
  return `${body.slice(0, MAX_FILE_CHARS)}\n\n[file truncated]`;
}

/**
 * Strict payload check for the main `ask` handler. The renderer always
 * sends a well-formed `AskRequest`, so reaching a throw means a version
 * mismatch or a corrupted payload — both deserve a visible error card,
 * not a silently degraded answer (the bug-10 rule).
 */
export function parseAskPayload(payload: unknown): {
  request: AskRequest;
  taskId?: string;
} {
  const shape = (payload ?? {}) as Record<string, unknown>;
  const { question, note, extraFiles, images, chatPath, liveEdit, noteKey, taskId } = shape;
  if (typeof question !== 'string') {
    throw new Error('malformed ask payload');
  }
  if (note !== null && !isAskFile(note)) {
    throw new Error('malformed ask payload: note must be { path, body } or null');
  }
  if (!Array.isArray(extraFiles) || !extraFiles.every(isAskFile)) {
    throw new Error('malformed ask payload: extraFiles must be an array of { path, body }');
  }
  if (!Array.isArray(images) || !images.every((p): p is string => typeof p === 'string')) {
    throw new Error('malformed ask payload: images must be an array of vault paths');
  }
  if (chatPath !== null && typeof chatPath !== 'string') {
    throw new Error('malformed ask payload: chatPath must be a path or null');
  }
  if (typeof liveEdit !== 'boolean') {
    throw new Error('malformed ask payload: liveEdit must be a boolean');
  }
  if (liveEdit && note === null) {
    throw new Error('malformed ask payload: liveEdit requires an attached note');
  }
  if (noteKey !== undefined && noteKey !== null && typeof noteKey !== 'string') {
    throw new Error('malformed ask payload: noteKey must be a doc key or null');
  }
  return {
    request: {
      question,
      note: note === null ? null : (note as AskFile),
      extraFiles: extraFiles as AskFile[],
      images: images as string[],
      chatPath,
      liveEdit,
      noteKey: noteKey === undefined ? null : (noteKey as string | null),
    },
    ...(typeof taskId === 'string' ? { taskId } : {}),
  };
}

function isAskFile(value: unknown): value is AskFile {
  const file = value as { path?: unknown; body?: unknown } | null;
  return (
    !!file &&
    typeof file === 'object' &&
    typeof file.path === 'string' &&
    typeof file.body === 'string'
  );
}
