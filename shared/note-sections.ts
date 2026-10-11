/**
 * Heading-delimited note sections, the one definition for the base and the
 * plugins: a section runs from one ATX heading to the next heading of any
 * level; content before the first heading is one implicit section; fences
 * hide `#` runs.
 *
 * `splitSections` is the unit the tags plugin's index and search report on
 * (`#sailing` AND `#kauf` means both tags appear in the same `Section`)
 * and what gives a backlink row its heading. `sectionAtLine` /
 * `appendTagsToSection` serve the editor's "Suggest tags" row: the LLM
 * sees one section and the suggested tags are appended into it.
 */

import { extractInlineTags } from './tag-grammar';

export interface NoteSection {
  /** 1-based first line of the section (the heading line, or line 1). */
  startLine: number;
  /** 1-based last line of the section, inclusive. */
  endLine: number;
  /** The section's text (heading line included), outer blank lines trimmed. */
  text: string;
}

export interface Section {
  /** Heading text without the leading `#`s, or `''` for the pre-heading part. */
  heading: string;
  /** 1–6 for a real heading, 0 for the implicit pre-heading section. */
  level: number;
  /** 1-based line the section starts on (the heading line, or line 1). */
  line: number;
  /** The section's text, heading line excluded, outer blank lines trimmed. */
  text: string;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;
const TABLE_ROW = /^\s*\|/;
const BLOCKQUOTE = /^\s*>/;
const HTML_BLOCK = /^<[a-zA-Z!/]/;

/** Every section of `body`, in document order. */
export function splitSections(body: string): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  let heading = '';
  let level = 0;
  let startLine = 1;
  let buf: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = buf.join('\n').replace(/^\s+|\s+$/g, '');
    // Drop an empty pre-heading section; keep every real heading section
    // even when its body is blank.
    if (level === 0 && text === '') {
      return;
    }
    sections.push({ heading, level, line: startLine, text });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    const m = inFence ? null : HEADING.exec(line);
    if (m) {
      flush();
      heading = m[2];
      level = m[1].length;
      startLine = i + 1;
      buf = [];
    } else {
      buf.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * The 1-based line of the closing `---` of a YAML frontmatter block, or
 * `0` when the content has none. A block only counts when it starts on
 * line 1, exactly like the editor's own fold.
 */
export function frontmatterEndLine(content: string): number {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return 0;
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return i + 1;
    }
  }
  return 0;
}

/**
 * The heading-delimited section containing 1-based `line` (clamped into
 * the document). The caret's section even when it sits in the implicit
 * pre-heading part or on the heading line itself.
 */
export function sectionAtLine(content: string, line: number): NoteSection {
  const lines = content.split('\n');
  const target = Math.min(Math.max(1, line), lines.length) - 1;

  // Section start indices: every heading line outside fences, plus an
  // implicit section start at 0 when content precedes the first heading.
  const starts: number[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && HEADING.test(lines[i])) {
      starts.push(i);
    }
  }
  if (starts.length === 0 || starts[0] > 0) {
    starts.unshift(0);
  }

  let s = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= target) {
      s = starts[i];
    } else {
      break;
    }
  }
  const next = starts.find((start) => start > s);
  const e = (next ?? lines.length) - 1;

  return {
    startLine: s + 1,
    endLine: e + 1,
    text: lines.slice(s, e + 1).join('\n').replace(/^\s+|\s+$/g, ''),
  };
}

/**
 * Appends `tags` (`#`-prefixed, space-separated) to the section's last
 * prose line and returns the new content. Prose means: not blank, not in a
 * fence, not a table row / blockquote / HTML block / heading. With no
 * prose line at all (e.g. a heading-only or fenced-only section) the tags
 * become a new line after the section's last non-blank line.
 *
 * Tags already present anywhere in the section (case-insensitive, via the
 * shared tag grammar -- code spans and fences never match) are dropped;
 * when nothing remains, `content` is returned unchanged.
 */
export function appendTagsToSection(
  content: string,
  startLine: number,
  endLine: number,
  tags: string[],
): string {
  const lines = content.split('\n');
  const si = Math.max(0, startLine - 1);
  const ei = Math.min(lines.length - 1, endLine - 1);

  const existing = new Set(extractInlineTags(lines.slice(si, ei + 1).join('\n')));
  const fresh = tags.filter((tag) => !existing.has(tag.toLowerCase()));
  if (fresh.length === 0) {
    return content;
  }
  const tail = fresh.map((tag) => `#${tag}`).join(' ');

  // One forward pass: track fence state, remember the last prose line and
  // the last non-blank line.
  let anchor = -1;
  let lastNonBlank = -1;
  let inFence = false;
  for (let i = si; i <= ei; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (line.trim() !== '') {
      lastNonBlank = i;
    }
    if (
      line.trim() !== '' &&
      !TABLE_ROW.test(line) &&
      !BLOCKQUOTE.test(line) &&
      !HTML_BLOCK.test(line) &&
      !HEADING.test(line)
    ) {
      anchor = i;
    }
  }

  if (anchor >= 0) {
    lines[anchor] = `${lines[anchor]} ${tail}`;
    return lines.join('\n');
  }
  const at = lastNonBlank >= 0 ? lastNonBlank + 1 : si;
  lines.splice(at, 0, tail);
  return lines.join('\n');
}
