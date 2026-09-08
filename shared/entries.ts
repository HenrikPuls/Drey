/**
 * Splits a note body into its dated entries (milestone 6b routing). An
 * entry is a timestamp heading -- `## HH:mm` (daily-note style),
 * `## YYYY-MM-DD HH:mm`, or `### YYYY-MM-DD HH:mm` (master History style),
 * each optionally followed by ` — <topic>` -- plus the text up to the next
 * such heading. Pure; used by `electron/note-manager.ts` to decide what to
 * route.
 *
 * A single-`#` title like `# 2026-09-06` is not an entry (no time); a
 * heading with no date (`## 14:32`) reports `date: null` and the caller
 * fills it from the note's own date.
 *
 * The optional topic suffix comes from the entry drawer, which writes
 * `## HH:mm — <Thema>` (see `shared/entry-compose.ts`). It has to be part
 * of THIS parser rather than a separate one: routing, `untaggedEntryText`
 * and the master-document History all walk entries through here, and a
 * topic-carrying entry that failed to parse would silently stop being
 * routed. A bare title with no dash (`## 14:32 Rollout`) still does not
 * match -- that stays prose, as before.
 *
 * An entry template may put a horizontal rule (and a tag line) right
 * under the heading (the "Ruled" built-in). A leading `---` line is
 * stripped from an entry's `text`; a leading `#tag` line is stripped only
 * when a blank line follows it -- the exact "Ruled" signature -- so a
 * Classic body that legitimately opens with a hashtag is never eaten.
 */

export interface DatedEntry {
  /** Heading text without the leading `#`s, e.g. `08:00` or `2026-09-06 14:32 — Rollout`. */
  heading: string;
  /** `YYYY-MM-DD` when the heading carries one, else `null`. */
  date: string | null;
  /** `HH:mm` exactly as written. */
  time: string;
  /** The ` — <topic>` suffix without the dash, or `null` when the heading has none. */
  title: string | null;
  /** Entry body between this heading and the next (or end), outer whitespace trimmed. */
  text: string;
}

// `## HH:mm`, `## YYYY-MM-DD HH:mm`, `### YYYY-MM-DD HH:mm`, each with an
// optional ` — <topic>` and an optional trailing `<!-- ... -->` (the
// routing marker). `<` is excluded from the topic so the marker can never
// be swallowed into it.
const ENTRY_HEADING =
  /^(#{2,3})[ \t]+(?:(\d{4}-\d{2}-\d{2})[ \t]+)?(\d{1,2}:\d{2})[ \t]*(?:(?:—|–|--)[ \t]*([^\n<]*?)[ \t]*)?(?:<!--[^\n]*-->[ \t]*)?$/gm;

/** The heading line an entry with these parts is written as (without `#`s). */
export function formatEntryHeading(
  date: string | null,
  time: string,
  title: string | null,
): string {
  const stamp = `${date ? `${date} ` : ''}${time}`;
  return title ? `${stamp} — ${title}` : stamp;
}

export function parseDatedEntries(body: string): DatedEntry[] {
  const heads: Array<{
    start: number;
    end: number;
    date: string | null;
    time: string;
    title: string | null;
  }> = [];
  for (const match of body.matchAll(ENTRY_HEADING)) {
    const title = match[4]?.trim();
    heads.push({
      start: match.index,
      end: match.index + match[0].length,
      date: match[2] ?? null,
      time: match[3],
      title: title ? title : null,
    });
  }

  return heads.map((head, i) => {
    const textEnd = i + 1 < heads.length ? heads[i + 1].start : body.length;
    return {
      heading: formatEntryHeading(head.date, head.time, head.title),
      date: head.date,
      time: head.time,
      title: head.title,
      text: body
        .slice(head.end, textEnd)
        .replace(/^\n/, '')
        .replace(/^(?:-{3,}|\*{3,}|_{3,})[ \t]*\n/, '')
        .replace(/^(?:#[\w-]+(?:[ \t]+#[\w-]+)*)[ \t]*\n(?=[ \t]*\n|[ \t]*$)/, '')
        .replace(/^\n+/, '')
        .replace(/\s+$/, ''),
    };
  });
}
