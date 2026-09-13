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
}

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
  const { question, note, extraFiles, images, chatPath, taskId } = shape;
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
  return {
    request: {
      question,
      note: note === null ? null : (note as AskFile),
      extraFiles: extraFiles as AskFile[],
      images: images as string[],
      chatPath,
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
