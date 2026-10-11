/**
 * What the Search panel does to a list of hits before showing it: fold
 * the unsaved buffers of open tabs in, and group per file. No DOM.
 */
import type { TagSearchHit, TagSearchQuery } from '../../../shared/plugin-api/renderer';
import { runTagSearch } from '../shared/search.js';
import { sectionRecordsFor } from '../shared/section-records.js';

/** A hit with an optional semantic score — the panel renders a rank badge when present. */
export type PanelHit = TagSearchHit & { score?: number };

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
  readonly hits: PanelHit[];
}

/** The hits per file, files sorted by path; hits keep their order. */
export function groupHits(hits: readonly PanelHit[]): HitGroup[] {
  const groups = new Map<string, { path: string; vaultId: string | null; hits: PanelHit[] }>();
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
