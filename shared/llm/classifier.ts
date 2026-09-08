/**
 * The two classifier prompts from `specs/classifier-spec.md`, as pure
 * message builders + reply parsers. `electron/llm/classifier.ts` calls the
 * LM Studio client with these and hands the raw reply back here to parse.
 *
 * Prompts are English (CLAUDE.md language convention). The note content
 * they process may be any language; the model is only asked for a
 * structured JSON verdict.
 */
import { formatDate } from '../timestamp';
import { ChatMessage, parseJsonObject } from './llm';

// -- Prompt 1: task vs. note (runs on every capture) -------------------------

export type TaskPriority = 'high' | 'medium' | 'low';

export interface TaskClassification {
  type: 'task' | 'note';
  /** `YYYY-MM-DD` due date read from the wording, or `null`. */
  due: string | null;
  priority: TaskPriority | null;
}

const TASK_SYSTEM = `You classify a short, informally written note. Decide whether it is a task (something still to be done) or a plain observation/note. If it is a task, read a due date and an urgency from the wording where possible.

Today's date: {current_date}

Respond ONLY with this JSON, no prose:
{"type": "task" | "note", "due": "YYYY-MM-DD" | null, "priority": "high" | "medium" | "low" | null}`;

export function buildTaskMessages(text: string, now: Date = new Date()): ChatMessage[] {
  return [
    { role: 'system', content: TASK_SYSTEM.replace('{current_date}', formatDate(now)) },
    { role: 'user', content: text },
  ];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTaskClassification(reply: string): TaskClassification | null {
  const obj = parseJsonObject(reply);
  if (!obj) {
    return null;
  }
  const type = obj['type'] === 'task' ? 'task' : obj['type'] === 'note' ? 'note' : null;
  if (type === null) {
    return null;
  }
  const due = typeof obj['due'] === 'string' && DATE_RE.test(obj['due']) ? obj['due'] : null;
  const priority =
    obj['priority'] === 'high' || obj['priority'] === 'medium' || obj['priority'] === 'low'
      ? (obj['priority'] as TaskPriority)
      : null;
  return { type, due, priority };
}

// -- Prompt 2: tag suggestion (batch, for entries with no tag) ---------------

export interface TagSuggestion {
  /** 1-3 tags picked from the known list, lowercased, de-duplicated. */
  suggestions: string[];
  /** A proposed new tag when nothing fit, else `null`. One word, lowercase. */
  new_tag: string | null;
}

/**
 * Builds the tag-suggestion request. `systemPrompt` is the Autotagging
 * action template's prompt text, with `{registry_list}` swapped for
 * `registryText` (the rendered known-tag list). The note goes in as the
 * user message. Wired up by milestone 11.7.
 */
export function buildTagSuggestionMessages(
  systemPrompt: string,
  registryText: string,
  noteText: string,
): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt.replace('{registry_list}', registryText) },
    { role: 'user', content: noteText },
  ];
}

/**
 * Parses the drawer "Autotag" reply -- `{"tags": ["a", "b"]}` -- into up to
 * four normalised, de-duplicated tag tokens. Anything unparseable yields `[]`.
 */
export function parseSuggestedTags(reply: string): string[] {
  const obj = parseJsonObject(reply);
  const raw = obj && Array.isArray(obj['tags']) ? obj['tags'] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    const token = normalizeTagToken(item);
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
    if (out.length === 4) {
      break;
    }
  }
  return out;
}

/**
 * Lowercase, transliterate umlauts/ß, collapse to one hyphenated word.
 * `/` is kept so a nested suggestion (`project/frontend`) survives, with
 * stray separators around it tidied up.
 */
export function normalizeTagToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/-*\/-*/g, '/')
    .replace(/^[-/]+|[-/]+$/g, '');
}

export function parseTagSuggestion(reply: string): TagSuggestion | null {
  const obj = parseJsonObject(reply);
  if (!obj) {
    return null;
  }
  const rawList = Array.isArray(obj['suggestions']) ? obj['suggestions'] : [];
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const item of rawList) {
    if (typeof item !== 'string') {
      continue;
    }
    const token = normalizeTagToken(item);
    if (token && !seen.has(token)) {
      seen.add(token);
      suggestions.push(token);
    }
    if (suggestions.length === 3) {
      break;
    }
  }
  const rawNew = obj['new_tag'];
  const new_tag =
    typeof rawNew === 'string' && normalizeTagToken(rawNew) ? normalizeTagToken(rawNew) : null;

  if (suggestions.length === 0 && new_tag === null) {
    return null;
  }
  return { suggestions, new_tag };
}
