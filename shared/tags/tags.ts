/**
 * Inline `#tag` extraction. `#task` stays a structural marker (task lines),
 * never a tag; `#important` used to be one too but no longer carries
 * special meaning, so it is an ordinary tag now. Fenced and inline code
 * spans are ignored; `## 14:32` / `### 2026-09-05` timestamp headings never
 * match (a `#` run is not followed by a letter).
 *
 * Moved here from the old `shared/inline-tags.ts` when the tag system
 * became index + search.
 */

const RESERVED = new Set(['task']);

/** `#` + a letter, then letters/digits/`_`/`-`. Preceded by start-of-line or whitespace. */
const INLINE_TAG = /(?:^|\s)#(\p{L}[\p{L}\p{N}_-]*)/gu;

/** Lower-cased, order-preserving, de-duplicated inline tags in `body`. */
export function extractInlineTags(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { tag } of extractTagOccurrences(body)) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/**
 * Every inline-tag occurrence with its character offset **in the original
 * `body`** (code spans are blanked out for matching but offsets still line
 * up, so a snippet / line number can be produced). Order is document order;
 * duplicates are kept.
 */
export function extractTagOccurrences(body: string): Array<{ tag: string; index: number }> {
  const scannable = blankCode(body);
  const out: Array<{ tag: string; index: number }> = [];
  for (const match of scannable.matchAll(INLINE_TAG)) {
    const tag = match[1].toLowerCase();
    if (RESERVED.has(tag)) {
      continue;
    }
    // `match.index` points at the leading whitespace/BOL; the `#` is next.
    const hashAt = scannable.indexOf('#', match.index);
    out.push({ tag, index: hashAt });
  }
  return out;
}

/** Replaces fenced blocks and inline code with same-length blanks so offsets survive. */
function blankCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/~~~[\s\S]*?~~~/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}
