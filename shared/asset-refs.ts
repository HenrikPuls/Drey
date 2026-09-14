/**
 * Resolution of an asset reference from a note (`![](url)`, `![[name]]`,
 * `<img src>`): the ordered vault-relative candidate list both the editor's
 * image widgets and the PDF export walk. Pure and dependency-free so the
 * renderer (`src/app/editor/vault-image.ts`, which maps candidates to
 * `drey-asset://` URLs) and the main process (`electron/pdf-export.ts`,
 * which maps them to absolute `file://` URLs) share ONE chain — milestone
 * 31, replacing the two hand-rolled copies that had already drifted.
 *
 * Candidate order for a reference `r` in a note at `dir/note.md`:
 *   1. `dir/r`     — note-relative first (the documented semantics)
 *   2. `r`         — the same read from the vault root (heals chat notes'
 *                    verbatim `attachments/...` lines and moved notes)
 *   3. `dir/attachments/<bare>` and 4. `attachments/<bare>` — for a bare
 *      file name only: pasted/dropped assets land in the referencing
 *      note's `attachments/` folder, and Obsidian-migrated vaults keep a
 *      vault-root `attachments/` folder (`![[Pasted image ….png]]`).
 */

export type ResolvedAssetRef =
  /** http(s)/data: — usable as-is, no vault involvement. */
  | { kind: 'passthrough'; url: string }
  /** Ordered vault-relative candidates; empty when nothing is servable. */
  | { kind: 'vault'; candidates: string[] };

/** Collapse `.`/`..` segments; return `null` if the path climbs above the root. */
export function normalizeRelative(pathStr: string): string | null {
  const out: string[] = [];
  for (const seg of pathStr.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (out.length === 0) {
        return null;
      }
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

/**
 * Ordered candidates for one asset reference. An empty `candidates` list
 * covers every unresolvable case: no reference, a foreign scheme
 * (`file:`, `ftp:`, …), or a path escaping the vault.
 */
export function resolveAssetRef(docPath: string | null, rawUrl: string): ResolvedAssetRef {
  const url = rawUrl.trim();
  if (url === '') {
    return { kind: 'vault', candidates: [] };
  }
  if (/^(https?:|data:)/i.test(url)) {
    return { kind: 'passthrough', url };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return { kind: 'vault', candidates: [] };
  }
  const baseDir =
    docPath !== null && docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const candidates: string[] = [];
  const addCandidate = (normalized: string): void => {
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };
  const push = (ref: string): void => {
    const normalized = normalizeRelative(ref);
    if (normalized === null || normalized === '') {
      return;
    }
    addCandidate(normalized);
    // markdown-it percent-encodes image destinations before handing them
    // to the PDF export (`pic%20x.png`), while the file on disk carries
    // the literal name — offer the decoded reading too.
    if (/%[0-9a-f]{2}/i.test(normalized)) {
      try {
        const decoded = normalizeRelative(decodeURIComponent(normalized));
        if (decoded !== null && decoded !== '') {
          addCandidate(decoded);
        }
      } catch {
        // A malformed escape — the raw form is all we have.
      }
    }
  };
  push(baseDir !== '' ? `${baseDir}/${url}` : url);
  push(url);
  if (!url.includes('/')) {
    push(baseDir !== '' ? `${baseDir}/attachments/${url}` : `attachments/${url}`);
    push(`attachments/${url}`);
  }
  return { kind: 'vault', candidates };
}
