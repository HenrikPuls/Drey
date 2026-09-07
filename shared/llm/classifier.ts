/**
 * The two classifier prompts from `specs/classifier-spec.md`, as pure
 * message builders + reply parsers. `electron/classifier.ts` calls the LM
 * Studio client with these and hands the raw reply back here to parse.
 *
 * Prompt text stays German -- it processes German note content and a small
 * local model does better with a matching language (CLAUDE.md language
 * convention; `specs/classifier-spec.md`).
 */
import { formatDate } from '../timestamp';
import { ChatMessage, parseJsonObject } from './llm';

// -- Prompt 1: task vs. note (runs on every capture) -------------------------

export type TaskPriority = 'hoch' | 'mittel' | 'niedrig';

export interface TaskClassification {
  typ: 'task' | 'notiz';
  /** `YYYY-MM-DD` due date read from the wording, or `null`. */
  faelligkeit: string | null;
  prioritaet: TaskPriority | null;
}

const TASK_SYSTEM = `Du analysierst eine kurze, informell geschriebene Notiz auf Deutsch. Bestimme, ob es eine Aufgabe (etwas, das noch erledigt werden muss) oder eine reine Beobachtung/Notiz ist. Falls Aufgabe: erkenne, wenn möglich, Fälligkeit und Dringlichkeit aus der Formulierung.

Heutiges Datum: {current_date}

Antworte AUSSCHLIESSLICH mit diesem JSON-Format, ohne Erklärung:
{"typ": "task" | "notiz", "faelligkeit": "YYYY-MM-DD" | null, "prioritaet": "hoch" | "mittel" | "niedrig" | null}`;

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
  const typ = obj['typ'] === 'task' ? 'task' : obj['typ'] === 'notiz' ? 'notiz' : null;
  if (typ === null) {
    return null;
  }
  const faelligkeit =
    typeof obj['faelligkeit'] === 'string' && DATE_RE.test(obj['faelligkeit'])
      ? obj['faelligkeit']
      : null;
  const prioritaet =
    obj['prioritaet'] === 'hoch' ||
    obj['prioritaet'] === 'mittel' ||
    obj['prioritaet'] === 'niedrig'
      ? (obj['prioritaet'] as TaskPriority)
      : null;
  return { typ, faelligkeit, prioritaet };
}

// -- Prompt 2: tag suggestion (batch, for entries with no tag) ---------------

export interface TagSuggestion {
  /** 1-3 tags picked from the registry, lowercased, de-duplicated. */
  vorschlaege: string[];
  /** A proposed new tag when nothing fit, else `null`. One word, lowercase, no umlauts. */
  neuer_tag: string | null;
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

/** Lowercase, strip umlauts/ß, keep one word (`specs/classifier-spec.md`: "keine Umlaute"). */
export function normalizeTagToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseTagSuggestion(reply: string): TagSuggestion | null {
  const obj = parseJsonObject(reply);
  if (!obj) {
    return null;
  }
  const rawList = Array.isArray(obj['vorschlaege']) ? obj['vorschlaege'] : [];
  const seen = new Set<string>();
  const vorschlaege: string[] = [];
  for (const item of rawList) {
    if (typeof item !== 'string') {
      continue;
    }
    const token = normalizeTagToken(item);
    if (token && !seen.has(token)) {
      seen.add(token);
      vorschlaege.push(token);
    }
    if (vorschlaege.length === 3) {
      break;
    }
  }
  const rawNew = obj['neuer_tag'];
  const neuer_tag =
    typeof rawNew === 'string' && normalizeTagToken(rawNew) ? normalizeTagToken(rawNew) : null;

  if (vorschlaege.length === 0 && neuer_tag === null) {
    return null;
  }
  return { vorschlaege, neuer_tag };
}
