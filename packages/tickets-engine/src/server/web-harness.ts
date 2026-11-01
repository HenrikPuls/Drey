/**
 * The web harness's browser-E2E skeleton (E4, ADR-0088): the loopback
 * static server the verify driver serves the built app from, the phone
 * viewport the proof screenshots are taken at, and the lazy Playwright
 * seam. The engine ships without the playwright dependency, so the import
 * happens at run time behind `chromiumAvailable` / `launchChromium` and
 * degrades to a clear error instead of a crash. E5's Mission Control PWA
 * driver builds on these; E4 keeps them deliberately small.
 */
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** `serveFolder`'s options. */
export interface ServeFolderOptions {
  /** The loopback port; 0 = a free one (the default). */
  readonly port?: number;
}

/** A running static server — the driver points the browser at `baseUrl`. */
export interface ServedFolder {
  readonly baseUrl: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Serves `dir` on 127.0.0.1 with `cache-control: no-store`. Known types
 * only, `..`/backslash/NUL refused, directories served through their
 * `index.html` (404 without one). Loopback-only: the served app is a
 * build artifact, never a network service.
 */
export async function serveFolder(dir: string, options: ServeFolderOptions = {}): Promise<ServedFolder> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    void handleStatic(root, req, res).catch(() => {
      if (!res.headersSent) {
        send(res, 500, { ok: false, error: 'internal error' });
      } else {
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    server.close();
    throw new Error('the static server did not bind');
  }
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${bound.port}`,
    port: bound.port,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleStatic(root: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, { ok: false, error: 'only GET is served here' });
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://webharness.invalid').pathname);
  } catch {
    send(res, 404, { ok: false, error: 'not found' });
    return;
  }
  if (pathname.includes('..') || pathname.includes('\\') || pathname.includes('\0')) {
    send(res, 404, { ok: false, error: 'not found' });
    return;
  }
  let file = path.resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    send(res, 404, { ok: false, error: 'not found' });
    return;
  }
  const stat = await fsp.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    file = path.join(file, 'index.html');
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
  if (type === undefined) {
    send(res, 404, { ok: false, error: 'not found' });
    return;
  }
  const content = await fsp.readFile(file).catch(() => null);
  if (content === null) {
    send(res, 404, { ok: false, error: 'not found' });
    return;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': content.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : content);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** The phone-shaped viewport the proof card's screenshots are taken at. */
export interface PhoneViewport {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  /** An honest placeholder: a Drey token, mobile enough for the responsive layout. */
  readonly userAgent: string;
}

/** The Mission Control phone shape (iPhone 12/13/14 logical points). */
export function phoneViewport(): PhoneViewport {
  return {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) DreyVerify/0.1 Mobile Safari/537.36',
  };
}

/** The playwright module or loader injected by tests; absent = the lazy import. */
export interface WebHarnessOptions {
  /** The `playwright` module (specs inject a fake); absent = `import('playwright')`. */
  readonly playwright?: unknown;
  /** Test seam over the lazy import itself — failure injection, one level below `playwright`. */
  readonly loadPlaywright?: () => Promise<unknown>;
}

/** The launched browser, E4-minimal: one phone-viewport page at a time. */
export interface ChromiumSession {
  /** Opens a fresh page at {@link phoneViewport}. */
  newPage(): Promise<unknown>;
  close(): Promise<void>;
}

/** The slice of playwright the harness touches — local types, no dependency. */
interface PlaywrightBoundary {
  readonly chromium: {
    launch(options: { headless: boolean }): Promise<ChromiumBoundary>;
  };
}

interface ChromiumBoundary {
  newPage(options: { viewport: PhoneViewport }): Promise<unknown>;
  close(): Promise<void>;
}

const INSTALL_HINT = 'install playwright where the engine runs (`npm i -D playwright`) and its browser (`npx playwright install chromium`)';

async function loadPlaywright(options: WebHarnessOptions): Promise<unknown> {
  if (options.loadPlaywright !== undefined) {
    return await options.loadPlaywright();
  }
  if (options.playwright !== undefined) {
    return options.playwright;
  }
  return await import('playwright');
}

function asPlaywrightBoundary(module: unknown): PlaywrightBoundary {
  const candidate = module as { chromium?: { launch?: unknown } } | null | undefined;
  if (typeof candidate?.chromium?.launch !== 'function') {
    throw new Error(`the loaded 'playwright' module has no chromium.launch — ${INSTALL_HINT}`);
  }
  return module as PlaywrightBoundary;
}

/** True when a playwright module loads and looks launchable; never throws. */
export async function chromiumAvailable(options: WebHarnessOptions = {}): Promise<boolean> {
  try {
    asPlaywrightBoundary(await loadPlaywright(options));
    return true;
  } catch {
    return false;
  }
}

/**
 * Launches headless chromium at the phone viewport. A missing playwright
 * or a refused launch rethrows with the install hint — the verify service
 * records it as the run's error instead of crashing the engine.
 */
export async function launchChromium(options: WebHarnessOptions = {}): Promise<ChromiumSession> {
  let module: unknown;
  try {
    module = await loadPlaywright(options);
  } catch (error) {
    throw new Error(`playwright could not be loaded — ${INSTALL_HINT}`, { cause: error });
  }
  const boundary = asPlaywrightBoundary(module);
  let browser: ChromiumBoundary;
  try {
    browser = await boundary.chromium.launch({ headless: true });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`chromium did not launch: ${why} — ${INSTALL_HINT}`, { cause: error });
  }
  return {
    newPage: () => Promise.resolve(browser.newPage({ viewport: phoneViewport() })),
    close: () => Promise.resolve(browser.close()),
  };
}
