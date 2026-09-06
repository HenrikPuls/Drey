/**
 * The document-rewrite half of the Actions system: turning a model reply
 * into a concrete `before` -> `after` for the confirmation flow. Split from
 * `shared/actions.ts` because these functions need the frontmatter/`yaml`
 * stack and are only ever called in the main process
 * (`electron/action-runner.ts`) -- keeping them out of `shared/actions.ts`
 * keeps `yaml` out of the renderer bundle (ADR-0007).
 *
 * Pure string in / string out; the Vitest suite covers them.
 */
import { parseDatedEntries } from '../entries';
import { readFrontmatter, splitFrontmatter, writeFrontmatter } from '../frontmatter';
import { extractInlineTags } from '../inline-tags';
import { formatTimestamp } from '../timestamp';

// -- Autotagging ------------------------------------------------------------

/**
 * The text handed to the tag-suggestion prompt for a document: every dated
 * entry that carries no inline `#tag`, joined. Falls back to the whole body
 * (minus frontmatter) when the note has no dated entries or all of them are
 * already tagged -- an untagged plain note still wants a suggestion.
 */
export function untaggedEntryText(body: string): string {
  const noteBody = splitFrontmatter(body).body;
  const untagged = parseDatedEntries(noteBody).filter(
    (entry) => entry.text.trim() !== '' && extractInlineTags(entry.text).length === 0,
  );
  if (untagged.length > 0) {
    return untagged.map((entry) => entry.text).join('\n\n');
  }
  return noteBody.trim();
}

/**
 * Merges `add` into the frontmatter `tags` array (lower-cased,
 * order-preserving, no duplicates) and returns the rewritten note text plus
 * the tags that were actually new. `null` when the note has no frontmatter
 * fence or nothing would change -- the caller reports "no suggestion applied".
 */
export function mergeFrontmatterTags(
  body: string,
  add: readonly string[],
): { text: string; added: string[] } | null {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) {
    return null;
  }
  const existing = frontmatter.tags.map((tag) => tag.toLowerCase());
  const seen = new Set(existing);
  const added: string[] = [];
  for (const raw of add) {
    const tag = raw.toLowerCase().trim();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      added.push(tag);
    }
  }
  if (added.length === 0) {
    return null;
  }
  return { text: writeFrontmatter(body, { tags: [...existing, ...added] }), added };
}

// -- Summary rebuild ------------------------------------------------------------

const SUMMARY_HEADING = /^##[ \t]+(?:Summary|Zusammenfassung)[ \t]*$/;
/** A section heading (`## ...`), not an entry heading (`### ...`). */
const SECTION_HEADING = /^##[ \t]/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Builds the entry text handed to the summary prompt: History entries from
 * the last `windowDays` (relative to the newest entry), plus any older
 * entry marked `#important`, oldest first. Each rendered as
 * `### <heading>\n<text>`.
 */
export function selectSummaryInput(masterBody: string, windowDays = 7): string {
  const entries = parseDatedEntries(splitFrontmatter(masterBody).body).filter(
    (entry) => entry.text.trim() !== '',
  );
  if (entries.length === 0) {
    return '';
  }

  const times = entries.map((entry) => {
    const value = entry.date ? Date.parse(`${entry.date}T${entry.time}:00`) : NaN;
    return Number.isNaN(value) ? null : value;
  });
  const newest = Math.max(0, ...times.filter((value): value is number => value !== null));

  const kept = entries.filter((entry, i) => {
    if (/#important\b/.test(entry.text)) {
      return true;
    }
    const time = times[i];
    return time === null || newest === 0 || newest - time <= windowDays * DAY_MS;
  });

  return kept.map((entry) => `### ${entry.heading}\n${entry.text}`).join('\n\n');
}

/**
 * Replaces the body of the `## Summary` section with `summaryText` and a
 * fresh `*(auto-generated, as of <timestamp>)*` line
 * (`specs/frontmatter-schema.md`). When the document has no `## Summary`
 * heading yet, one is inserted directly after the frontmatter.
 */
export function applySummarySection(
  masterBody: string,
  summaryText: string,
  now: Date = new Date(),
): string {
  const block = `*(auto-generated, as of ${formatTimestamp(now)})*\n\n${summaryText.trim()}`;

  const lines = masterBody.split('\n');
  const headingIdx = lines.findIndex((line) => SUMMARY_HEADING.test(line));
  if (headingIdx !== -1) {
    let endIdx = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (SECTION_HEADING.test(lines[i])) {
        endIdx = i;
        break;
      }
    }
    const head = lines.slice(0, headingIdx + 1).join('\n');
    const tail = lines.slice(endIdx).join('\n');
    return tail ? `${head}\n${block}\n\n${tail}` : `${head}\n${block}\n`;
  }

  const split = splitFrontmatter(masterBody);
  if (split.hadFence) {
    const fence = masterBody.slice(0, masterBody.length - split.body.length);
    return `${fence}\n## Summary\n${block}\n\n${split.body.replace(/^\n+/, '')}`;
  }
  return `## Summary\n${block}\n\n${masterBody.replace(/^\n+/, '')}`;
}
