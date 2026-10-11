import { splitSections } from '../../../shared/note-sections.js';
import { blankCode } from '../../../shared/tag-grammar.js';
import { extractWikilinks } from '../../../shared/wikilinks.js';

/**
 * Wikilink extraction for the backlink index (milestone 54), over the
 * base grammar (`shared/wikilinks.ts`): `[[target]]`, `[[target#heading]]`,
 * `[[target|alias]]`, `[[target#heading|alias]]` and embeds (`![[…]]` —
 * the brackets match inside, an embed references its target too).
 *
 * Scanning discipline mirrors the editor's guards: YAML frontmatter,
 * fenced blocks and inline code spans never yield links.
 */

/** One `[[target]]` occurrence, with where it sits for the panel row. */
export interface LinkOccurrence {
  /** Target (path or note name), trimmed; same-file `[[#heading]]` is skipped. */
  target: string;
  /** `#heading` anchor, trimmed, without the `#`. */
  anchor: string | null;
  /** 1-based line of the `[[`. */
  line: number;
  /** Heading of the section the link sits in (`''` before the first heading). */
  heading: string;
  /** The linking line's text, trimmed, capped for the panel row. */
  snippet: string;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const SNIPPET_MAX = 160;

function trimSnippet(line: string): string {
  const flat = line.trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX).trimEnd()}…` : flat;
}

/** The 1-based section heading for a line, from the fence-aware split. */
function headingAt(sections: ReturnType<typeof splitSections>, line: number): string {
  let heading = '';
  for (const section of sections) {
    if (section.line <= line) {
      heading = section.heading;
    } else {
      break;
    }
  }
  return heading;
}

/**
 * Every wikilink occurrence in `content`, document order. Frontmatter and
 * code are excluded; a same-file `[[#heading]]` (empty target) is not a
 * backlink source and is skipped, like `[[]]` / `[[|alias]]`.
 */
export function extractLinkTargets(content: string): LinkOccurrence[] {
  const fm = FRONTMATTER.exec(content);
  const fmLines = fm !== null ? (fm[0].match(/\n/g) ?? []).length : 0;
  // blankCode preserves offsets but REPLACES newlines inside fences with
  // spaces — line numbers are counted over the raw slice instead.
  const raw = fm !== null ? content.slice(fm[0].length) : content;
  const scannable = blankCode(raw);
  const sections = splitSections(content);

  const out: LinkOccurrence[] = [];
  let line = 1 + fmLines;
  let cursor = 0;
  for (const link of extractWikilinks(scannable)) {
    const index = link.index;
    for (let i = cursor; i < index; i++) {
      if (raw.charCodeAt(i) === 10) {
        line++;
      }
    }
    cursor = index;
    if (link.target === '') {
      continue; // `[[#heading]]` — the note itself, not a backlink source.
    }
    out.push({
      target: link.target,
      anchor: link.anchor,
      line,
      heading: headingAt(sections, line),
      snippet: trimSnippet(lineText(content, line)),
    });
  }
  return out;
}

function lineText(text: string, line: number): string {
  const lines = text.split('\n');
  return lines[line - 1] ?? '';
}
