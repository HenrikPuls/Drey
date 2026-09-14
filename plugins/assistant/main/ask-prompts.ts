/**
 * The Ask prompts and the current-turn user message builder, extracted
 * from `action-engine.ts` when the ask flow moved to the chat engine
 * (ADR-0048). Pure string shaping — the engine decides WHICH system
 * prompt and what history rides along.
 */
import type { AskRequest } from '../shared/ask';
import { MAX_EXTRA_FILES } from '../shared/ask.js';

export const ASK_SYSTEM = `You are working on a Markdown document. The user either asks a question about it or gives an instruction to change it. Further files may be attached below the document; treat them as read-only reference for this reply.

Two reply forms, nothing else:
- Question (answer only, change nothing): answer in plain prose. No JSON, no code fences around the answer.
- Change: at most one short lead-in sentence, then the FULL changed document in a fenced block whose info string is "document", opened with FOUR backticks so ordinary fences inside the document survive:

\`\`\`\`document
...the complete document...
\`\`\`\`

For a change you ALWAYS return the whole document, not just the changed part.
Earlier turns of this conversation are shown as plain text; these two reply forms still apply.`;

/**
 * Answer-only variant, used when the note chip is deselected (`note:
 * null`): there is no document to edit, so the document-fence form is
 * dropped entirely — the model has nothing to return a whole document
 * against.
 */
export const ASK_ANSWER_SYSTEM = `You are answering the user's questions about their note vault. The attached files are read-only context for this reply -- there is no document to edit.

Answer in plain prose. No JSON, no code fences around the answer.

Earlier turns of this conversation are shown as plain text; this reply form still applies.`;

/** Appended to `ASK_SYSTEM` when the vault tool set is available (ADR-0021). */
export const ASK_TOOLS_NOTE = `You may call the vault tools (vault_search, vault_read, vault_write) to look things up in the wider vault or to make changes elsewhere before you give your final answer. A vault_write is confirmed by the user unless the app is in YOLO mode.`;

/** One-line catch-up for a resumed session that never saw the confirm result. */
export function editCatchUpLine(path: string, applied: boolean): string {
  return applied
    ? `Context since your last turn: the change you proposed to \`${path}\` was applied by the user.`
    : `Context since your last turn: the change you proposed to \`${path}\` was discarded by the user.`;
}

export function buildAskUserMessage(request: AskRequest): string {
  const parts = [`INSTRUCTION / QUESTION:\n${request.question.trim()}`];
  if (request.note !== null) {
    parts.push(`DOCUMENT (${request.note.path}):\n${request.note.body}`);
  }
  // The renderer already caps the count (`MAX_EXTRA_FILES`); the slice is
  // defence in depth against an over-long payload.
  for (const file of request.extraFiles.slice(0, MAX_EXTRA_FILES)) {
    parts.push(`FILE (${file.path}):\n${file.body}`);
  }
  return parts.join('\n\n');
}
