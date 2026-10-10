// Sibling specifiers need the explicit `.js`: emitted as CJS (main) and
// served over plugin:// (ESM).
import type { LinkOccurrence } from './link-targets.js';

/**
 * Obsidian-style link resolution — a parity twin of the base
 * `resolveNoteTarget` (`shared/wikilinks.ts`;
 * plugin code cannot import base modules). A target containing `/` or an
 * extension is a vault-relative path (`.md` appended when bare); anything
 * else is a note basename — unique names win outright, ambiguous ones
 * prefer a sibling of the linking note, then the shortest path, then a
 * locale compare. The backlink query inverts this: a link counts as a
 * backlink of exactly the note the EDITOR would open.
 */

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

/** Resolves a link target to a vault-relative path, or null when unknown. */
export function resolveTargetLink(
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
  const fromDir =
    fromPath && fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const sibling = hits.find((p) => parentDir(p) === fromDir);
  if (sibling) {
    return sibling;
  }
  return [...hits].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

function parentDir(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** One backlink row — the linking file and where the link sits. */
export interface BacklinkRow {
  /** Vault-relative path of the linking note. */
  path: string;
  /** Heading of the section the link sits in (`''` before the first heading). */
  heading: string;
  /** 1-based line of the `[[`. */
  line: number;
  /** The linking line's text, trimmed. */
  snippet: string;
}

/**
 * Every link that resolves to `targetPath` — the inverse of the editor's
 * resolution, so a row's Ctrl-click in the source note and the panel's
 * row agree on what is linked. Self-links (a note linking itself) are not
 * backlinks. Rows sort by path, then line.
 */
export function collectBacklinks(
  targetPath: string,
  outlinks: ReadonlyMap<string, readonly LinkOccurrence[]>,
  index: NoteIndex,
): BacklinkRow[] {
  const rows: BacklinkRow[] = [];
  for (const [fromPath, links] of outlinks) {
    if (fromPath === targetPath) {
      continue;
    }
    for (const link of links) {
      if (resolveTargetLink(link.target, fromPath, index) === targetPath) {
        rows.push({ path: fromPath, heading: link.heading, line: link.line, snippet: link.snippet });
      }
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return rows;
}
