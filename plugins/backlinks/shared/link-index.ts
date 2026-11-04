import {
  resolveNoteTarget,
  resolveWikilinkAcrossVaults,
  type NoteIndex,
  type VaultNoteIndex,
} from '../../../shared/wikilinks.js';
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
  /**
   * The linking note's vault -- set only on a row that links in from
   * ANOTHER vault through the link fallback (E13-4); absent = the same
   * vault as the note the panel shows.
   */
  vaultId?: string;
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

/** One vault whose links may point into another vault (E13-4). */
export interface FallbackSource {
  vaultId: string;
  outlinks: ReadonlyMap<string, readonly LinkOccurrence[]>;
}

/**
 * Backlinks that reach `target` from OTHER vaults through the link
 * fallback (E13-4): a link in a source vault counts only when it matches
 * nothing in its own vault and the fallback search (`vaults` is the full
 * fallback order -- active vault first, then the registry order) lands on
 * `target` as the first match. A name that is ambiguous across fallback
 * vaults therefore counts for the first match only, exactly where Ctrl-click
 * would open it. Rows carry the linking note's `vaultId`.
 */
export function collectFallbackBacklinks(
  target: { vaultId: string; path: string },
  sources: readonly FallbackSource[],
  vaults: readonly VaultNoteIndex[],
): BacklinkRow[] {
  const rows: BacklinkRow[] = [];
  for (const source of sources) {
    if (source.vaultId === target.vaultId) {
      continue;
    }
    for (const [fromPath, links] of source.outlinks) {
      for (const link of links) {
        const hit = resolveWikilinkAcrossVaults(link.target, source.vaultId, fromPath, vaults, true);
        if (hit !== null && hit.fallback && hit.vaultId === target.vaultId && hit.path === target.path) {
          rows.push({
            path: fromPath,
            heading: link.heading,
            line: link.line,
            snippet: link.snippet,
            vaultId: source.vaultId,
          });
        }
      }
    }
  }
  rows.sort(
    (a, b) =>
      (a.vaultId ?? '').localeCompare(b.vaultId ?? '') || a.path.localeCompare(b.path) || a.line - b.line,
  );
  return rows;
}
