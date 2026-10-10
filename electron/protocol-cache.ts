import * as fs from 'node:fs';
import * as path from 'node:path';
import { net } from 'electron';
import { pathToFileURL } from 'node:url';

/**
 * Shared serving for the `app://` and `plugin://` handlers (milestone 61).
 *
 * Measured reality on the dev machine (documented honestly): Chromium
 * does not store custom-scheme responses in its HTTP cache — no
 * `If-None-Match` revalidation ever arrives, so the 304 branch stays
 * cold and the `codeCache` scheme privilege showed no measurable parse
 * improvement either. The machinery is kept anyway: it is correct
 * (hashed assets immutable, everything else revalidating), it replaces
 * the plugin handler's old whole-file buffering with streaming, and it
 * centralizes MIME handling — the caching parts activate the day
 * Electron's network service honors them for custom schemes.
 */

/** Matches esbuild's content-hashed output names: `*-<8+ word chars>.<ext>`. */
const HASHED_NAME = /-[A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$/;

/** True for renderer files whose name carries a content hash. */
export function isHashedAsset(relativePath: string): boolean {
  return HASHED_NAME.test(path.basename(relativePath));
}

/**
 * Serves `filePath` with cache headers:
 * - `immutable: true` → `public, max-age=31536000, immutable` (hashed assets)
 * - otherwise → `no-cache` (store, but revalidate every time via ETag)
 * The ETag is `"<mtime36>-<size36>"` — changes whenever the file does.
 * `contentType` (the plugin handler's explicit MIME map) overrides the
 * sniffed one — Windows' `file://` MIME guessing is registry-dependent
 * and a JS module without a JS Content-Type is refused outright.
 */
export async function serveWithCaching(
  request: Request,
  filePath: string,
  opts: { immutable: boolean; contentType?: string },
): Promise<Response> {
  let size: number;
  let mtimeMs: number;
  try {
    const stat = await fs.promises.stat(filePath);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const etag = `"${Math.round(mtimeMs).toString(36)}-${size.toString(36)}"`;
  const cacheControl = opts.immutable
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': cacheControl, 'Access-Control-Allow-Origin': '*' },
    });
  }
  let fileResponse: Response;
  try {
    fileResponse = await net.fetch(pathToFileURL(filePath).toString());
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers({
    ETag: etag,
    'Cache-Control': cacheControl,
    'Access-Control-Allow-Origin': '*',
  });
  headers.set(
    'Content-Type',
    opts.contentType ?? fileResponse.headers.get('content-type') ?? 'application/octet-stream',
  );
  return new Response(fileResponse.body, { status: 200, headers });
}
