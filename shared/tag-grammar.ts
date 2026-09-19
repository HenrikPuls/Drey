/**
 * The canonical inline `#tag` grammar, shared by base-side consumers (the
 * editor tag features, the entry drawer's draft service).
 *
 * `#task` stays a structural marker (task lines), never a tag;
 * `#important` used to be one too but no longer carries special meaning, so
 * it is an ordinary tag now. Fenced and inline code spans are ignored;
 * `## 14:32` / `### 2026-09-05` timestamp headings never match (a `#` run
 * is not followed by a letter).
 *
 * Tags can be nested with `/`, e.g. `#project/frontend` -- these are label
 * hierarchies, not folders (ADR-0017); a tag search for `#project` also
 * returns the `#project/*` sections (see `plugins/tags/shared/search.ts`).
 *
 * TWIN ALERT: `plugins/tags/shared/tags.ts` is a verbatim twin of this
 * file. Plugin *renderers* load over `plugin://`, which cannot reach files
 * outside the plugin root, so the tags plugin keeps its own copy. A parity
 * spec (`tag-grammar-parity.spec.ts`) runs the same assertions over both;
 * if you change one, change the other in the same commit.
 */

const RESERVED = new Set(['task']);

/**
 * The first tag segment must start with a Unicode letter -- this is what
 * keeps `## 2026-09-05` / `## 14:32` timestamp headings from matching.
 */
const TAG_HEAD = String.raw`\p{L}[\p{L}\p{N}_-]*`;
/** Later `/`-separated segments may also start with a digit (`#project/2024`). */
const TAG_TAIL = String.raw`[\p{L}\p{N}_-]+`;

/**
 * The tag name (no leading `#`): a {@link TAG_HEAD} then zero or more
 * `/`-separated {@link TAG_TAIL} segments, no empty or trailing segment.
 * Exported as a source string so the editor's autocomplete and the other
 * tag parsers build their partial/anchored regexes from the same rule.
 */
export const TAG_NAME_SOURCE = `${TAG_HEAD}(?:/${TAG_TAIL})*`;

/**
 * `#` + a {@link TAG_NAME_SOURCE}. Preceded by start-of-line or whitespace,
 * so URL fragments (`…/#frag`) and `#!/bin/sh` never match.
 */
const INLINE_TAG = new RegExp(String.raw`(?:^|\s)#(${TAG_NAME_SOURCE})`, 'gu');

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
    // `#task` and any `#task/*` subtree stay a structural marker, not a tag.
    if (RESERVED.has(tag.split('/', 1)[0])) {
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
