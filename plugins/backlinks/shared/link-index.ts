import { resolveNoteTarget, type NoteIndex } from '../../../shared/wikilinks.js';
import type { LinkOccurrence } from './link-targets.js';

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
 * resolution (`resolveNoteTarget`, the function the editor itself uses), so a row's Ctrl-click in the source note and the panel's
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
      if (resolveNoteTarget(link.target, fromPath, index) === targetPath) {
        rows.push({ path: fromPath, heading: link.heading, line: link.line, snippet: link.snippet });
      }
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return rows;
}
