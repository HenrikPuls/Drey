/**
 * Extracts inline `#tag` markers from a note body (milestone 6). Pure;
 * used by `note:save` to feed the frontmatter `tags` merge and, from
 * milestone 6b, the per-entry routing.
 *
 * `specs/frontmatter-schema.md`: body `#tag`s are the input, frontmatter
 * `tags` is the deduplicated aggregate. `#task` and `#important` are
 * structural markers (task lines / summary pinning), not topics, so they
 * are never treated as tags here.
 */

const DENYLIST = new Set(['task', 'important']);

/** A `#` followed by a letter, then letters/digits/`_`/`-`. Preceded by start-of-line or whitespace. */
const INLINE_TAG = /(?:^|\s)#(\p{L}[\p{L}\p{N}_-]*)/gu;

/**
 * Lower-cased, order-preserving, de-duplicated list of inline tags in
 * `body`. Fenced and inline code spans are ignored; `## 14:32` /
 * `### 2026-09-05` timestamp headings never match (a `#` run is not
 * followed by a letter).
 */
export function extractInlineTags(body: string): string[] {
  const scannable = stripCode(body);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of scannable.matchAll(INLINE_TAG)) {
    const tag = match[1].toLowerCase();
    if (DENYLIST.has(tag) || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}
