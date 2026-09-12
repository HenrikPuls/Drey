/**
 * The ask contract between the assistant panel (renderer) and the
 * ActionEngine (main): one `AskRequest` with the note context (nullable —
 * the note chip can be deselected) plus reference-only extra files.
 *
 * Replaces the old flat `{ context: { path, body }, question, … }` payload
 * when the panel grew context chips (milestone 24): the note became
 * optional, files became plural. Renderer + main ship in one build, so the
 * switch is a clean break, not a negotiated migration.
 *
 * Lives in the plugin's `shared/` like `chat-thread.ts`: imported by both
 * of its consumers. The `ChatMessage` import is type-only from the app's
 * `shared/llm`, so it is erased in both compile targets and the file stays
 * runtime-self-contained.
 */

import type { ChatMessage } from '../../../shared/llm';

/** One file attached to an ask turn. `body` is the document text (LF). */
export interface AskFile {
  path: string;
  body: string;
}

/**
 * One ask turn. `note: null` means the note chip is deselected: there is
 * no document to edit, so the turn is answer-only (the engine picks the
 * matching system prompt and ignores an `edit` reply).
 */
export interface AskRequest {
  question: string;
  /** The open note with its live buffer, or `null` when the chip is off. */
  note: AskFile | null;
  /** Reference-only attachments; never an edit target. */
  extraFiles: AskFile[];
}

/** Cap on attached files per ask turn (the composer enforces it, too). */
export const MAX_EXTRA_FILES = 10;

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
 * not a silently degraded answer (the bug-10 rule, same message style the
 * inline handler used before this module existed).
 */
export function parseAskPayload(payload: unknown): {
  request: AskRequest;
  taskId?: string;
  history: ChatMessage[];
} {
  const shape = (payload ?? {}) as Record<string, unknown>;
  const { question, note, extraFiles, taskId, history } = shape;
  if (typeof question !== 'string') {
    throw new Error('malformed ask payload');
  }
  if (note !== null && !isAskFile(note)) {
    throw new Error('malformed ask payload: note must be { path, body } or null');
  }
  if (!Array.isArray(extraFiles) || !extraFiles.every(isAskFile)) {
    throw new Error('malformed ask payload: extraFiles must be an array of { path, body }');
  }
  // bug-10 (interim): a missing or malformed `history` must fail VISIBLY,
  // not silently degrade to an empty-context answer -- the renderer always
  // sends an array, so reaching this branch means a version mismatch or a
  // corrupted payload, and either deserves an error card, not a
  // confidently wrong answer.
  if (!Array.isArray(history)) {
    throw new Error(
      'malformed ask payload: history must be an array (stale renderer or main process? restart the app)',
    );
  }
  for (const item of history) {
    const message = item as { role?: unknown; content?: unknown } | null;
    if (
      !message ||
      typeof message !== 'object' ||
      typeof message.role !== 'string' ||
      typeof message.content !== 'string'
    ) {
      throw new Error('malformed ask payload: history entries must be { role, content }');
    }
  }
  return {
    request: {
      question,
      note: note === null ? null : (note as AskFile),
      extraFiles: extraFiles as AskFile[],
    },
    ...(typeof taskId === 'string' ? { taskId } : {}),
    history: history as ChatMessage[],
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
