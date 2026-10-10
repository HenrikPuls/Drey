// Sibling specifiers need the explicit `.js`: emitted as CJS (main) and
// served over plugin:// (ESM).
import { splitSections } from './sections.js';

/**
 * Wikilink extraction for the backlink index (milestone 54). The regex is
 * a verbatim twin of the base editor's (`shared/wikilinks.ts`)
 * — plugin renderers cannot import base modules, so the grammar lives here
 * as a parity-tested copy: `[[target]]`, `[[target#heading]]`,
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

/** Verbatim twin of the base WIKILINK regex (parity spec guards drift). */
const WIKILINK = /\[\[([^\[\]#|\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g;

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const SNIPPET_MAX = 160;

/** Replaces fenced blocks and inline code with same-length blanks (twin of the tags plugin's `blankCode`). */
function blankCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/~~~[\s\S]*?~~~/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

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
  for (const match of scannable.matchAll(WIKILINK)) {
    const index = match.index ?? 0;
    for (let i = cursor; i < index; i++) {
      if (raw.charCodeAt(i) === 10) {
        line++;
      }
    }
    cursor = index;
    const target = (match[1] ?? '').trim();
    if (target === '') {
      continue; // `[[#heading]]` — the note itself, not a backlink source.
    }
    const anchor = match[2] !== undefined ? match[2].trim() : null;
    out.push({
      target,
      anchor,
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
