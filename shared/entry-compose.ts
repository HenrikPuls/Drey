/**
 * Builds the Markdown block the entry drawer appends to a document, and
 * appends it. Pure and shared: the renderer composes the preview and the
 * actual insertion from the same function, so what the drawer shows and
 * what lands in the file cannot drift apart.
 *
 * The block is a **chosen template** (`AppConfig.entry`, see
 * `shared/app-config.ts`) with `{{time}} {{date}} {{datetime}} {{title}}
 * {{tags}} {{content}}` substituted. `{{title}}` expands to `''` or
 * ` — <Topic>`; `{{tags}}` to `''` or `#a #b`; `{{content}}` to the body.
 * After substitution, blank lines are collapsed and a trailing rule line
 * is dropped -- so an empty entry stays byte-identical to a bare
 * `## HH:mm` for every template, which `shared/entries.ts` parses back.
 *
 * The built-in "Classic" template (`CLASSIC_ENTRY_PATTERN`) reproduces the
 * pre-template shape exactly.
 */
import { substitutePlaceholders } from './placeholders';
import { formatDate, formatDateTime, formatTime } from './timestamp';

/** What the drawer collected. All parts optional except the text. */
export interface EntryDraft {
  /** The prominent TOPIC field. Empty string when the user left it blank. */
  topic: string;
  /** Body Markdown, as typed. */
  text: string;
  /** Bare tag names, no leading `#`. */
  tags: readonly string[];
}

export const EMPTY_ENTRY_DRAFT: EntryDraft = {
  topic: '',
  text: '',
  tags: [],
};

/** The already-resolved placeholder values a template pattern is filled with. */
export interface EntryParts {
  time: string;
  date: string;
  datetime: string;
  /** `''` or ` — <Topic>` (dropped straight into a heading line). */
  title: string;
  /** `''` or `#a #b`. */
  tags: string;
  /** `''` or the body Markdown. */
  content: string;
}

/** `#tag #tag`, or `''` when nothing is tagged. */
export function formatEntryMeta(draft: EntryDraft): string {
  return clean(draft.tags)
    .map((tag) => `#${tag.replace(/^#/, '')}`)
    .join(' ');
}

/**
 * Fills `pattern`'s placeholders and tidies the result:
 *  - a pattern line that was **only** placeholder(s) and renders empty is
 *    dropped entirely (so an empty entry is a bare `## HH:mm` for any
 *    template, and "Classic" stays byte-identical to the old output);
 *  - per-line trailing whitespace stripped, runs of blank lines collapsed
 *    to one, no leading or trailing blank line;
 *  - a trailing horizontal-rule line removed (a topic-only "Ruled" entry
 *    would otherwise end on a dangling `---`).
 */
export function substituteEntryTemplate(pattern: string, parts: EntryParts): string {
  const rendered: string[] = [];
  for (const patternLine of pattern.split('\n')) {
    const filled = substitutePlaceholders(patternLine, { ...parts });
    if (filled === '' && /\{\{\w+\}\}/.test(patternLine)) {
      continue;
    }
    rendered.push(filled);
  }

  const lines: string[] = [];
  for (const raw of rendered.join('\n').split('\n')) {
    const line = raw.replace(/[ \t]+$/, '');
    if (line === '') {
      if (lines.length > 0 && lines[lines.length - 1] !== '') {
        lines.push('');
      }
    } else {
      lines.push(line);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  while (lines.length > 0 && /^(-{3,}|\*{3,}|_{3,})$/.test(lines[lines.length - 1])) {
    lines.pop();
  }
  return lines.join('\n');
}

/**
 * The full entry block for `pattern`, without a trailing newline. `now` is
 * injectable so tests (and a future "backdate this entry") don't depend on
 * wall time.
 */
export function composeEntry(draft: EntryDraft, pattern: string, now: Date = new Date()): string {
  const topic = draft.topic.trim();
  return substituteEntryTemplate(pattern, {
    time: formatTime(now),
    date: formatDate(now),
    datetime: formatDateTime(now),
    title: topic === '' ? '' : ` — ${topic}`,
    tags: formatEntryMeta(draft),
    content: draft.text.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
  });
}

/**
 * The edit that appends the entry to `body`: a replacement of the
 * document's trailing whitespace by one blank line plus the entry. Given as
 * a range rather than a whole new document so the editor can dispatch it as
 * an ordinary CodeMirror change -- which keeps undo history, the caret and
 * the scroll position intact (swapping the entire document resets all
 * three).
 */
export function entryInsertion(
  body: string,
  draft: EntryDraft,
  pattern: string,
  now: Date = new Date(),
): { from: number; to: number; insert: string } {
  const base = body.replace(/\s+$/, '');
  const separator = base === '' ? '' : '\n\n';
  return {
    from: base.length,
    to: body.length,
    insert: `${separator}${composeEntry(draft, pattern, now)}\n`,
  };
}

/**
 * `entryInsertion` applied to the text: the resulting document plus the
 * offset the entry starts at. Used for previews and tests; the editor
 * dispatches the range form instead.
 */
export function appendEntry(
  body: string,
  draft: EntryDraft,
  pattern: string,
  now: Date = new Date(),
): { text: string; at: number } {
  const edit = entryInsertion(body, draft, pattern, now);
  const text = body.slice(0, edit.from) + edit.insert;
  return { text, at: text.length - edit.insert.length + (edit.insert.startsWith('\n\n') ? 2 : 0) };
}

/** Whether there is anything worth appending at all. */
export function hasEntryContent(draft: EntryDraft): boolean {
  return draft.topic.trim() !== '' || draft.text.trim() !== '' || clean(draft.tags).length > 0;
}

function clean(list: readonly string[]): string[] {
  return list.map((item) => item.trim()).filter((item) => item !== '');
}
