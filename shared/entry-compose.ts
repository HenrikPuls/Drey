/**
 * Builds the Markdown block the entry drawer appends to a document, and
 * appends it. Pure and shared: the renderer composes the preview and the
 * actual insertion from the same function, so what the drawer shows and
 * what lands in the file cannot drift apart.
 *
 * The shape:
 *
 *     ## HH:mm — <Topic>
 *     <Markdown-Text>
 *     #tag #tag
 *
 * The meta line is omitted when there are no tags; the topic (and its dash)
 * when there is no topic -- which keeps a plain drawer entry byte-identical
 * to a bare `## HH:mm` block, so nothing downstream has to special-case it.
 * `shared/entries.ts` parses both shapes back.
 */
import { formatEntryHeading } from './entries';
import { formatTime } from './timestamp';

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

/** `#tag #tag`, or `''` when nothing is tagged. */
export function formatEntryMeta(draft: EntryDraft): string {
  return clean(draft.tags)
    .map((tag) => `#${tag.replace(/^#/, '')}`)
    .join(' ');
}

/**
 * The full entry block, without a trailing newline. `now` is injectable so
 * tests (and a future "backdate this entry") don't depend on wall time.
 */
export function composeEntry(draft: EntryDraft, now: Date = new Date()): string {
  const heading = `## ${formatEntryHeading(null, formatTime(now), draft.topic.trim() || null)}`;
  const lines = [heading];
  const text = draft.text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (text.trim() !== '') {
    lines.push(text);
  }
  const meta = formatEntryMeta(draft);
  if (meta !== '') {
    lines.push(meta);
  }
  return lines.join('\n');
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
  now: Date = new Date(),
): { from: number; to: number; insert: string } {
  const base = body.replace(/\s+$/, '');
  const separator = base === '' ? '' : '\n\n';
  return {
    from: base.length,
    to: body.length,
    insert: `${separator}${composeEntry(draft, now)}\n`,
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
  now: Date = new Date(),
): { text: string; at: number } {
  const edit = entryInsertion(body, draft, now);
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
