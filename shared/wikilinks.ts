/**
 * The `[[wikilink]]` grammar and Obsidian-style resolution (ADR-0046), in
 * `shared/` since milestone 59 so the renderer (`WikilinkService`, the
 * editor decorations) and the main process (the rename link rewrite,
 * `shared/link-rewrite.ts`) and the backlinks plugin agree on ONE
 * definition of what a link is and which note it opens.
 */

export interface WikilinkOccurrence {
  /** Position of the opening `[` within the scanned text. */
  index: number;
  /** Length of the whole `[[...]]` span. */
  length: number;
  /** Target (path or note name), trimmed; `''` for a same-file `[[#heading]]`. */
  target: string;
  /** `#heading` anchor, trimmed, without the `#`. */
  anchor: string | null;
  /** Display alias after `|`, trimmed. */
  alias: string | null;
  /** End of `target[#anchor]`, relative to `index` -- a `|` or the `]]` follows. */
  contentEnd: number;
  /** Start of the alias text, relative to `index` (only when `alias`). */
  aliasStart: number;
  /** Length of the RAW (untrimmed) target text, which starts at `index + 2`. */
  rawTargetLength: number;
}

const WIKILINK = /\[\[([^\[\]#|\n]*)(?:#([^\[\]|\n]+))?(?:\|([^\[\]\n]+))?\]\]/g;

/**
 * Every wikilink in `text`. Brackets inside the target are rejected by the
 * character classes (no nested `[`/`]`); `#` ends the target and starts the
 * anchor; `|` ends target/anchor and starts the alias. Occurrences with an
 * empty target *and* no anchor (`[[]]`, `[[|x]]`) are skipped.
 */
export function extractWikilinks(text: string): WikilinkOccurrence[] {
  const out: WikilinkOccurrence[] = [];
  for (const match of text.matchAll(WIKILINK)) {
    const target = (match[1] ?? '').trim();
    const anchor = match[2] !== undefined ? match[2].trim() : null;
    const alias = match[3] !== undefined ? match[3].trim() : null;
    if (target === '' && anchor === null) {
      continue;
    }
    const index = match.index;
    // match[0] is `[[<raw target>][#<raw anchor>][|<raw alias>]]`; the raw
    // (untrimmed) target spans to the first `#` / `|` / `]]`.
    const rawTargetEnd = 2 + match[1].length;
    const contentEnd = anchor !== null ? rawTargetEnd + 1 + match[2].length : rawTargetEnd;
    out.push({
      index,
      length: match[0].length,
      target,
      anchor,
      alias,
      contentEnd,
      aliasStart: contentEnd + 1,
      rawTargetLength: match[1].length,
    });
  }
  return out;
}

/** The files a wikilink can resolve to -- what the editor treats as a note. */
export const NOTE_FILE = /\.(md|markdown|mdx)$/i;

export interface NoteIndex {
  /** lowercase full path -> real path */
  byPath: Map<string, string>;
  /** lowercase basename (no extension) -> real paths */
  byName: Map<string, string[]>;
  /** real paths, sorted */
  all: string[];
}

export function buildNoteIndex(paths: readonly string[]): NoteIndex {
  const sorted = [...paths].sort((a, b) => a.localeCompare(b));
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const path of sorted) {
    byPath.set(path.toLowerCase(), path);
    const file = path.slice(path.lastIndexOf('/') + 1);
    const base = file.replace(/\.[^.]+$/, '').toLowerCase();
    const list = byName.get(base);
    if (list) {
      list.push(path);
    } else {
      byName.set(base, [path]);
    }
  }
  return { byPath, byName, all: sorted };
}

function parentDir(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/**
 * Resolves a link target to a vault-relative path, or null when unknown.
 * A target containing `/` or an extension is a vault-relative path (`.md`
 * appended when bare); anything else is a note basename -- unique names win
 * outright, ambiguous ones prefer a sibling in the linking note's own
 * folder, then the shortest path, then a plain locale compare so the pick
 * is deterministic. An empty target (`[[#heading]]`) is the linking note.
 */
export function resolveNoteTarget(
  rawTarget: string,
  fromPath: string | null,
  index: NoteIndex,
): string | null {
  const target = rawTarget.trim();
  if (target === '') {
    return fromPath;
  }
  if (target.includes('/') || /\.[^/]+$/.test(target)) {
    const key = (/\.[^/]+$/.test(target) ? target : `${target}.md`).toLowerCase();
    return index.byPath.get(key) ?? null;
  }
  const hits = index.byName.get(target.toLowerCase());
  if (!hits || hits.length === 0) {
    return null;
  }
  if (hits.length === 1) {
    return hits[0];
  }
  const fromDir = fromPath !== null ? parentDir(fromPath) : '';
  const sibling = hits.find((p) => parentDir(p) === fromDir);
  if (sibling) {
    return sibling;
  }
  return [...hits].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}
