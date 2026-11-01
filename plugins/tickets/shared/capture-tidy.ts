/**
 * The capture tidy-up prompt and reply parser (req-75 W5c, T-0072):
 * one model call turns a dictated or hastily typed idea into a
 * ticket's title and description, on demand — the raw words are kept
 * in the ticket's Log so a misheard dictation can be recovered.
 *
 * Like the OCR prompt (ADR-0050) this lives in the plugin, not in
 * `shared/app-config.ts`: no user-editable template in v1. The call
 * itself runs main-side (`ctx.llm.chat` in the 'tidyCapture' IPC) —
 * the renderer never imports `shared/llm`.
 */
import type { ChatMessage } from '../../../shared/llm';
import { parseJsonObject } from '../../../shared/llm';

/** System prompt: the tidy-up contract (Prompt 4 in classifier-spec.md). */
export const CAPTURE_TIDY_SYSTEM = [
  'You turn a spoken or hastily typed idea into a ticket for a software project\'s backlog.',
  'Reply with one JSON object and nothing else: {"title": "...", "description": "..."}',
  'Rules:',
  '- title: at most 70 characters, a short noun phrase or imperative, no trailing period, no ticket id.',
  '- description: one to four short sentences in plain Markdown that keep every fact, name and constraint from the text. Drop filler words, false starts and repetitions.',
  '- Keep the language of the text. Do not add requirements, file names or solutions the text does not contain.',
].join('\n');

/** The message pair for `ctx.llm.chat`: the contract, then the raw text. */
export function captureTidyMessages(raw: string): ChatMessage[] {
  return [
    { role: 'system', content: CAPTURE_TIDY_SYSTEM },
    { role: 'user', content: raw.trim() },
  ];
}

/** What a tidy-up returns: the ticket's two text fields. */
export interface TidiedCapture {
  readonly title: string;
  readonly description: string;
}

/**
 * Parses the model's reply through `parseJsonObject`, so an object
 * wrapped in a code fence reads too: a title trimmed to a non-empty
 * 80 characters, a description trimmed with an empty one falling
 * back to the raw text. Anything else — no object, a broken one, a
 * missing or non-string field — is `null` and the fields stay.
 */
export function parseCaptureTidy(reply: string, raw: string): TidiedCapture | null {
  const parsed = parseJsonObject(reply);
  if (parsed === null) {
    return null;
  }
  const title = typeof parsed['title'] === 'string' ? parsed['title'].trim() : '';
  if (title === '' || typeof parsed['description'] !== 'string') {
    return null;
  }
  const description = parsed['description'].trim();
  return {
    title: title.slice(0, 80),
    description: description !== '' ? description : raw.trim(),
  };
}

/**
 * The Log line's text after the stamp and actor: the owner's original
 * words with every run of whitespace (newlines included) folded to
 * one space — one dictated paragraph stays one Log line — cut to
 * 2000 characters.
 */
export function rawCaptureLogText(raw: string): string {
  return `raw capture: ${raw.replace(/\s+/g, ' ').trim()}`.slice(0, 2000);
}
