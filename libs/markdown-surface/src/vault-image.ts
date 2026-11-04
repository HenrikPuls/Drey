/**
 * Turns an image reference in a note (`![](url)`) into a `src` the renderer
 * can load. The renderer has no filesystem access, so vault-relative paths
 * are rewritten to the `drey-asset://` scheme that the main process serves
 * from inside the named vault (see `electron/app-protocols.ts`). Since ADR-0051 the
 * vault id is the URL host (`drey-asset://<vaultId>/asset/<path>`) so the
 * same relative path resolves per vault; a null vaultId keeps the
 * host-less legacy form (served from the active vault).
 *
 * The candidate chain itself lives in `shared/asset-refs.ts` so the PDF
 * export resolves through the exact same list.
 */
import { resolveAssetRef, normalizeRelative } from '../../../shared/asset-refs';

export { normalizeRelative };

/**
 * How often each asset was reported changed this session (milestone 64).
 * An `<img>` never refetches an unchanged URL, so a picture rewritten on
 * disk -- a diagram saved by its editor tab -- gets `?v=<n>` appended; the
 * serving handler ignores the query.
 */
const assetRevisions = new Map<string, number>();

function toAssetUrl(relative: string, vaultId: string | null): string {
  const encoded = relative.split('/').map(encodeURIComponent).join('/');
  const url =
    vaultId !== null && vaultId !== ''
      ? `drey-asset://${vaultId}/asset/${encoded}`
      : `drey-asset://asset/${encoded}`;
  const revision = assetRevisions.get(relative);
  return revision === undefined ? url : `${url}?v=${revision}`;
}

/**
 * Vault files changed on disk (`vault:changed` push): every picture of
 * them -- already on screen or rendered later -- loads the new content.
 * `root` is where shown pictures are looked up (the document).
 */
export function refreshChangedAssets(
  vaultId: string | undefined,
  paths: readonly string[],
  root: ParentNode,
): void {
  const changed = new Set(paths);
  for (const path of changed) {
    assetRevisions.set(path, (assetRevisions.get(path) ?? 0) + 1);
  }
  for (const image of Array.from(root.querySelectorAll('img'))) {
    const src = image.getAttribute('src') ?? '';
    const ref = assetUrlToVaultPath(src);
    if (ref === null || !changed.has(ref.path)) {
      continue;
    }
    if (vaultId !== undefined && ref.vaultId !== null && ref.vaultId !== vaultId) {
      continue;
    }
    image.setAttribute('src', `${src.split('?')[0]}?v=${assetRevisions.get(ref.path)}`);
  }
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
  const ref = resolveAssetRef(docPath, rawUrl);
  if (ref.kind === 'passthrough') {
    return ref.url;
  }
  const first = ref.candidates[0];
  return first === undefined ? null : toAssetUrl(first, vaultId);
}

/**
 * Ordered servable candidates for one image reference, straight from the
 * shared chain (`shared/asset-refs.ts`): note-relative first, then the
 * vault-root reading, then — for a bare file name — the `attachments/`
 * folders beside the note and at the vault root. `http(s)`/`data:` pass
 * through as the single candidate; an unresolvable reference resolves to
 * no candidate.
 */
export function resolveVaultImageCandidates(
  docPath: string | null,
  rawUrl: string,
  vaultId: string | null = null,
): string[] {
  const ref = resolveAssetRef(docPath, rawUrl);
  if (ref.kind === 'passthrough') {
    return [ref.url];
  }
  return ref.candidates.map((candidate) => toAssetUrl(candidate, vaultId));
}

/**
 * Candidates for an in-app help document's image reference (ADR-0070).
 * Its relative refs resolve against `assetBase` (`manual/`) as RELATIVE
 * URLs, so the page's own origin serves them -- `ng serve` in dev,
 * `app://` packaged -- without hardcoding either. `http(s)`/`data:` pass
 * through; anything with an explicit scheme or a `..` escape yields no
 * candidate (the manual is trusted, its URLs still never leave the app).
 */
export function resolveHelpImageCandidates(assetBase: string, rawUrl: string): string[] {
  if (/^(?:https?|data):/i.test(rawUrl)) {
    return [rawUrl];
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl) || rawUrl.includes('..')) {
    return [];
  }
  const encoded = rawUrl.split('/').map(encodeURIComponent).join('/');
  return [`${assetBase}${encoded}`];
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
