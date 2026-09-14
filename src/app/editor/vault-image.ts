/**
 * Turns an image reference in a note (`![](url)`) into a `src` the renderer
 * can load. The renderer has no filesystem access, so vault-relative paths
 * are rewritten to the `drey-asset://` scheme that the main process serves
 * from inside the named vault (see `electron/main.ts`). Since ADR-0051 the
 * vault id is the URL host (`drey-asset://<vaultId>/asset/<path>`) so the
 * same relative path resolves per vault; a null vaultId keeps the
 * host-less legacy form (served from the active vault).
 */

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
 *  - `http(s):` / `data:` pass through unchanged;
 *  - any other explicit scheme -> `null` (not rendered);
 *  - otherwise resolve relative to the note's own folder and return a
 *    `drey-asset://[<vaultId>/]asset/<path>` URL.
 * `null` whenever the path can't be trusted (escapes the vault) or there is
 * no open document to resolve against.
 */
export function resolveVaultImageUrl(
  docPath: string | null,
  rawUrl: string,
  vaultId: string | null = null,
): string | null {
  const url = rawUrl.trim();
  if (!url) {
    return null;
  }
  if (/^(https?:|data:)/i.test(url)) {
    return url;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return null;
  }
  const baseDir =
    docPath && docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const joined = normalizeRelative(baseDir ? `${baseDir}/${url}` : url);
  if (joined === null || joined === '') {
    return null;
  }
  const encoded = joined.split('/').map(encodeURIComponent).join('/');
  return vaultId !== null && vaultId !== ''
    ? `drey-asset://${vaultId}/asset/${encoded}`
    : `drey-asset://asset/${encoded}`;
}

/**
 * Ordered servable candidates for one image reference: note-relative
 * first (the documented semantics), then the same target read from the
 * VAULT ROOT. The fallback heals notes that embed a vault-relative path —
 * assistant chat notes do (their attachment lines carry the
 * `vault:saveAsset` result verbatim), and a note moved between folders
 * keeps rendering such references. `http(s)`/`data:` pass through as the
 * single candidate; an unresolvable reference resolves to no candidate.
 */
export function resolveVaultImageCandidates(
  docPath: string | null,
  rawUrl: string,
  vaultId: string | null = null,
): string[] {
  const primary = resolveVaultImageUrl(docPath, rawUrl, vaultId);
  if (primary === null) {
    return [];
  }
  if (/^(https?:|data:)/i.test(rawUrl.trim())) {
    return [primary];
  }
  const fromRoot = resolveVaultImageUrl(null, rawUrl, vaultId);
  return fromRoot !== null && fromRoot !== primary ? [primary, fromRoot] : [primary];
}

/**
 * The inverse of {@link resolveVaultImageUrl} for `drey-asset://` URLs
 * (ADR-0052): takes a widget's resolved asset URL back to
 * `{ vaultId, path }` so the lens can open the file by vault-relative
 * path (`EditorService.openFile`). `null` for anything that is not an
 * asset URL (http/data/foreign scheme); the host-less legacy form maps to
 * `vaultId: null` (served from / opened in the active vault).
 */
export function assetUrlToVaultPath(url: string): { vaultId: string | null; path: string } | null {
  if (!url.startsWith('drey-asset://')) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = decodeURIComponent(parsed.hostname);
  // Mirrors the serving handler's stripping exactly (`registerAssetProtocol`):
  // the `/asset/` prefix off, then any leading slashes. (On the host-less
  // legacy form `asset` is the HOST, so the prefix strip is a no-op there
  // and only the slash trim applies.)
  const path = parsed.pathname
    .replace(/^\/asset\/?/, '')
    .replace(/^\/+/, '')
    .split('/')
    .map(decodeURIComponent)
    .join('/');
  if (!path) {
    return null;
  }
  return { vaultId: host === '' || host === 'asset' ? null : host, path };
}
