/**
 * What the Search panel does to a list of hits before showing it: fold
 * the unsaved buffers of open tabs in, and group per file. No DOM.
 */
import type { TagSearchHit, TagSearchQuery } from '../../../shared/plugin-api/renderer';
import { runTagSearch } from '../shared/search.js';
import { sectionRecordsFor } from '../shared/section-records.js';

/** An open tab with unsaved text, as far as the search needs it. */
export interface DirtyDoc {
  readonly path: string;
  readonly vaultId: string | null;
  readonly buffer: string;
}

/**
 * On-disk hits with the dirty tabs' files re-searched in their buffers:
 * a dirty file's disk hits are dropped and replaced by what its unsaved
 * text matches (marked `unsaved`). Sorted by path, vault, line.
 */
export function mergeOpenBufferHits(
  diskHits: readonly TagSearchHit[],
  dirty: readonly DirtyDoc[],
  query: TagSearchQuery,
): TagSearchHit[] {
  if (dirty.length === 0) {
    return [...diskHits];
  }
  const dirtyKeys = new Set(dirty.map((d) => `${d.vaultId} ${d.path}`));
  const merged: TagSearchHit[] = diskHits.filter(
    (h) => h.vaultId === undefined || !dirtyKeys.has(`${h.vaultId} ${h.path}`),
  );
  for (const doc of dirty) {
    for (const hit of runTagSearch(sectionRecordsFor(doc.path, doc.buffer), query)) {
      merged.push({ ...hit, unsaved: true, vaultId: doc.vaultId ?? undefined });
    }
  }
  merged.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.vaultId ?? '').localeCompare(b.vaultId ?? '') ||
      a.line - b.line,
  );
  return merged;
}

export interface HitGroup {
  /** `vaultId path` — one group per file per vault. */
  readonly key: string;
  readonly path: string;
  readonly vaultId: string | null;
  readonly hits: TagSearchHit[];
}

/** The hits per file, files sorted by path; hits keep their order. */
export function groupHits(hits: readonly TagSearchHit[]): HitGroup[] {
  const groups = new Map<string, { path: string; vaultId: string | null; hits: TagSearchHit[] }>();
  for (const hit of hits) {
    const key = `${hit.vaultId ?? ''} ${hit.path}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { path: hit.path, vaultId: hit.vaultId ?? null, hits: [] };
      groups.set(key, group);
    }
    group.hits.push(hit);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort((a, b) => a.path.localeCompare(b.path) || (a.key < b.key ? -1 : 1));
}

/** One run of a snippet: plain text, or a match to mark. */
export interface SnippetPart {
  readonly text: string;
  readonly mark: boolean;
}

/**
 * Splits a hit's snippet into plain and matched runs for the panel's mark.
 * Text mode marks every occurrence of each term (case as the query's match
 * option says); regex mode marks what the pattern matches. A snippet the
 * query cannot be applied to comes back as one plain run.
 */
export function snippetParts(snippet: string, query: TagSearchQuery): SnippetPart[] {
  const text = query.text.trim();
  if (text === '') {
    return [{ text: snippet, mark: false }];
  }
  const flags = `gu${query.match?.caseSensitive === true ? '' : 'i'}`;
  let pattern: RegExp;
  try {
    pattern =
      query.match?.regex === true
        ? new RegExp(text, flags)
        : new RegExp(
            text
              .split(/\s+/)
              .filter((term) => term !== '')
              .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
              .join('|'),
            flags,
          );
  } catch {
    return [{ text: snippet, mark: false }];
  }
  const parts: SnippetPart[] = [];
  let last = 0;
  for (const match of snippet.matchAll(pattern)) {
    if (match[0] === '') {
      continue;
    }
    const at = match.index ?? 0;
    if (at > last) {
      parts.push({ text: snippet.slice(last, at), mark: false });
    }
    parts.push({ text: match[0], mark: true });
    last = at + match[0].length;
  }
  if (last < snippet.length) {
    parts.push({ text: snippet.slice(last), mark: false });
  }
  return parts.length > 0 ? parts : [{ text: snippet, mark: false }];
}

/** A file path split for a group head: the name and the folder around it. */
export function splitPath(path: string): { name: string; folder: string } {
  const cut = path.lastIndexOf('/');
  return cut === -1
    ? { name: path, folder: '' }
    : { name: path.slice(cut + 1), folder: path.slice(0, cut) };
}
