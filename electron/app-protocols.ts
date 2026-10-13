import { net, protocol } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rendererDistDir, rendererOrigin } from './app-paths';
import { buildContentSecurityPolicy, CSP_HEADER, isAppDocument } from './content-security-policy';
import { isPathInside } from './path-guard';
import type { PluginHost } from './plugin-host';
import { isHashedAsset, serveWithCaching } from './protocol-cache';
import type { VaultManager } from './vault-manager';

/**
 * The three custom schemes the renderer loads from: `app://` (the built
 * page), `drey-asset://` (files inside a vault) and `plugin://` (a
 * plugin's renderer files).
 */

/**
 * Production loads go through a custom `app://` scheme instead of plain
 * `file://`. Angular's esbuild output is `<script type="module">`, and
 * Chromium refuses to load module scripts (and their relative imports)
 * from `file://` as a CORS violation -- the page loads with silently zero
 * content. A privileged custom scheme behaves like a normal origin
 * instead. Called at module load, before `app.whenReady()`: Electron
 * requires privileged schemes to be declared that early.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        // V8 code cache opt-in (milestone 61). Measured effect on the dev
        // machine: none (Chromium currently keeps custom-scheme responses
        // out of its caches no matter the headers) — kept as the
        // documented switch for the day that changes.
        codeCache: true,
      },
    },
    // Serves images referenced from notes (`![](relative/path.png)`) straight
    // from inside a registered vault. `standard` so
    // `drey-asset://<vaultId>/asset/<path>` parses with host = vault id and a
    // normal pathname; `secure` so an `<img>` on the privileged `app://` page
    // is allowed to load it; `corsEnabled` so the page may also `fetch` it
    // (the PDF embed probes its candidates that way) -- the handler names
    // the page's origin as the only one allowed to read the answer.
    {
      scheme: 'drey-asset',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    // Serves built renderer modules for plugins (ADR-0044):
    // `plugin://<pluginId>/<path under the plugin's renderer/ dir>`. `standard`
    // so the URL parses with host = plugin id (ids are lowercase by the id
    // pattern); `corsEnabled` because an ES-module import from the `app://`
    // page is a CORS-mode fetch, and the handler answers with explicit
    // Content-Type / Access-Control-Allow-Origin headers.
    {
      scheme: 'plugin',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        // Same V8 code cache opt-in and caveat as `app` (milestone 61).
        codeCache: true,
      },
    },
  ]);
}

/** Installs the handlers of all three schemes; called once the app is ready. */
export function registerProtocolHandlers(vaultManager: VaultManager, pluginHost: PluginHost): void {
  registerAppProtocol();
  registerAssetProtocol(vaultManager);
  registerPluginProtocol(pluginHost);
}

function registerAppProtocol(): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.normalize(path.join(rendererDistDir, relativePath));

    // Guard against escaping rendererDistDir (defense in depth; nothing
    // in the app currently constructs one, but the handler is a public
    // surface for anything the renderer navigates to).
    if (!isPathInside(rendererDistDir, filePath)) {
      return new Response('Forbidden', { status: 403 });
    }

    // Cache headers (milestone 61): hashed bundle files are immutable,
    // everything else (index.html, public/ assets) revalidates via ETag.
    // The page itself carries the Content-Security-Policy (ADR-0001, later
    // change); it governs everything the page then loads.
    return serveWithCaching(request, filePath, {
      immutable: isHashedAsset(relativePath),
      extraHeaders: isAppDocument(relativePath)
        ? { [CSP_HEADER]: buildContentSecurityPolicy() }
        : undefined,
    });
  });
}

/**
 * `drey-asset://<vaultId>/asset/<url-encoded vault-relative path>` -> the
 * file inside that vault (ADR-0051; the vaultId is the URL host, so the
 * same relative path can resolve differently per vault).
 * `VaultManager.resolveAssetPath` applies the same escape guard as the IPC
 * read path; anything it rejects (unknown vault, `..`, absolute) is a
 * plain 404. The renderer only ever builds these URLs from
 * `resolveVaultImageUrl`, which already normalises the path.
 */
function registerAssetProtocol(vaultManager: VaultManager): void {
  protocol.handle('drey-asset', (request) => {
    const url = new URL(request.url);
    // host = the vault id; `/asset/<path>` = the vault-relative path.
    const vaultId = decodeURIComponent(url.hostname);
    const relativePath = decodeURIComponent(url.pathname)
      .replace(/^\/asset\/?/, '')
      .replace(/^\/+/, '');
    const filePath = vaultManager.resolveAssetPath(relativePath, vaultId || undefined);
    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString()).then((response) => {
      const headers = new Headers(response.headers);
      // Only the app's own page may read a vault file through `fetch`.
      headers.set('Access-Control-Allow-Origin', rendererOrigin);
      // A PDF must arrive with an exact `application/pdf` Content-Type or
      // the built-in viewer refuses the frame (ADR-0052); the file://
      // loader's MIME guessing is registry-dependent on Windows, so it is
      // pinned here. Everything else keeps the sniffed headers (images
      // have worked through this channel since ADR-0024).
      if (filePath.toLowerCase().endsWith('.pdf')) {
        headers.set('Content-Type', 'application/pdf');
      }
      return new Response(response.body, { status: response.status, headers });
    });
  });
}

/**
 * `plugin://<pluginId>/<path under the plugin root>` -> that file
 * (built-ins: `<dist-electron>/plugins/<id>`; user-installed:
 * `<userData>/plugins/<id>`). The path is root-relative exactly like the
 * manifest's `renderer` / `css` entries, so `plugin://<id>/renderer/index.js`
 * serves `<root>/renderer/index.js`.
 *
 * The escape check is the same `isPathInside` the `app://` handler uses.
 * Module fetches are CORS-mode, so the
 * response carries explicit `Content-Type` (Chromium refuses a module
 * without a JS MIME type) and a permissive `Access-Control-Allow-Origin`.
 */
function registerPluginProtocol(pluginHost: PluginHost): void {
  const MIME_BY_EXT: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    // What the diagrams plugin's bundled web app serves besides the above
    // (ADR-0064); Windows' file:// MIME guessing is registry-dependent.
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
  };
  protocol.handle('plugin', async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const pluginId = url.hostname;
    const rootDir = pluginHost.rendererRootFor(pluginId);
    if (rootDir === null) {
      return new Response('Not found', { status: 404 });
    }
    const relativePath = decodeURIComponent(url.pathname);
    const filePath = path.normalize(path.join(rootDir, relativePath));
    if (!isPathInside(rootDir, filePath)) {
      return new Response('Forbidden', { status: 403 });
    }
    const ext = path.extname(filePath).toLowerCase();
    // ETag revalidation, never immutable (milestone 61): an app update
    // rewrites plugin files under stable names, so every launch
    // revalidates and only unchanged files answer 304 — the cached
    // scripts (and V8's bytecode for them) survive, changed ones reload.
    return serveWithCaching(request, filePath, {
      immutable: false,
      contentType: MIME_BY_EXT[ext],
    });
  });
}
