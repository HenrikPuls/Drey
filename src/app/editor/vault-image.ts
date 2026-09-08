/**
 * Turns an image reference in a note (`![](url)`) into a `src` the renderer
 * can load. The renderer has no filesystem access, so vault-relative paths
 * are rewritten to the `drey-asset://` scheme that the main process serves
 * from inside the active vault (see `electron/main.ts`).
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
 *    `drey-asset://asset/<path>` URL.
 * `null` whenever the path can't be trusted (escapes the vault) or there is
 * no open document to resolve against.
 */
export function resolveVaultImageUrl(docPath: string | null, rawUrl: string): string | null {
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
  return `drey-asset://asset/${joined.split('/').map(encodeURIComponent).join('/')}`;
}
