/**
 * The Ask prompts and the current-turn user message builder, extracted
 * from `action-engine.ts` when the ask flow moved to the chat engine
 * (ADR-0048). Pure string shaping: the role texts, the user message and
 * the naming call. `system-prompt.ts` assembles the system prompt around
 * the role text (environment, tools, rules — ADR-0071).
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
Use the Change form ONLY when the user explicitly asks you to modify, add to or rewrite the document. Everything else is a Question — including a short confirmation or follow-up to your own previous reply ("yes, do that", "go ahead"): continue what you offered there (look it up with your tools if you have any) and answer in prose. Never put an answer, a list or a lookup result into the document unless the user asked for it to be written there.
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

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The current date for every ask (57d): without it "recently", "overdue"
 * or "this week" cannot be judged — or turned into a date argument.
 */
export function buildDateNote(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `Today is ${now.getFullYear()}-${month}-${day} (${WEEKDAYS[now.getDay()]}).`;
}

/** One-line catch-up for a resumed session that never saw the confirm result. */
export function editCatchUpLine(path: string, applied: boolean): string {
  return applied
    ? `Context since your last turn: the change you proposed to \`${path}\` was applied by the user.`
    : `Context since your last turn: the change you proposed to \`${path}\` was discarded by the user.`;
}

export function buildAskUserMessage(request: AskRequest): string {
  const parts = [`INSTRUCTION / QUESTION:\n${request.question.trim()}`];
  // Asked from the selection button (milestone 74): the same block name the
  // Action engine uses, placed before the document it is a part of.
  if (request.selection !== undefined && request.selection.trim() !== '') {
    parts.push(
      `SELECTED SECTION (the question is about this part of the document):\n${request.selection}`,
    );
  }
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

/**
 * Chat naming (57e): a brand-new chat's title comes from the model, not
 * from the raw first question (which was a placeholder — often a long,
 * unpunctuated sentence). The call rides the SAME model, plain, no tools
 * and no history; the question plus a short answer snippet are enough.
 */
export const TITLE_SYSTEM = `You name chat conversations. Read the exchange below and reply with a concise title of two to six words, in the language of the conversation. Reply with the title only — no quotes, no surrounding punctuation, no sentence, no explanation.`;

/** The user message for the naming call: the exchange, capped. */
export function buildTitleUserMessage(question: string, answer: string): string {
  const parts = [`User: ${question.slice(0, 400)}`];
  if (answer !== '') {
    parts.push(`Assistant: ${answer.slice(0, 600)}`);
  }
  return parts.join('\n');
}

/**
 * Cleans a model reply into a frontmatter title: first non-empty line,
 * wrapping quotes and a trailing period dropped, whitespace collapsed,
 * capped at 60 chars on a word boundary. `null` when nothing usable
 * remains (the engine then keeps the question-derived title).
 */
export function sanitizeChatTitle(raw: string): string | null {
  const line = (raw ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  let title = line
    .replace(/^["'„“«»‘’]+/, '')
    .replace(/["'„“«»‘’]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!…]+$/, '')
    .trim();
  if (title.length > 60) {
    const cut = title.slice(0, 60);
    const lastSpace = cut.lastIndexOf(' ');
    title = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return title.length >= 2 ? title : null;
}
