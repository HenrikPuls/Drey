import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromiumAvailable, launchChromium, phoneViewport, serveFolder, type ServedFolder } from './web-harness';

/**
 * E4: the web-harness skeleton on a real loopback socket — static serving
 * with content types and traversal refusals, the phone viewport shape, and
 * the Playwright seam behind a fake module (no real browser in specs).
 */

let root: string;
let web: string;
let served: ServedFolder | null = null;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(tmpdir(), 'tickets-web-harness-'));
  web = path.join(root, 'web');
  await fsp.mkdir(web, { recursive: true });
});

afterEach(async () => {
  await served?.close();
  served = null;
  await fsp.rm(root, { recursive: true, force: true });
});

/** A GET with the exact request path — fetch would normalize `..` away. */
function rawGet(port: number, requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

async function seedFiles(): Promise<void> {
  await fsp.writeFile(path.join(web, 'index.html'), '<h1>the app</h1>', 'utf8');
  await fsp.writeFile(path.join(web, 'app.js'), 'console.log(1);', 'utf8');
  await fsp.writeFile(path.join(web, 'style.css'), 'body { margin: 0; }', 'utf8');
  await fsp.writeFile(path.join(web, 'data.json'), '{"a":1}', 'utf8');
  await fsp.writeFile(path.join(web, 'site.webmanifest'), '{}', 'utf8');
  await fsp.writeFile(path.join(web, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fsp.writeFile(path.join(web, 'icon.svg'), '<svg/>', 'utf8');
  await fsp.writeFile(path.join(web, 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  await fsp.writeFile(path.join(web, 'main.ts'), 'export {};', 'utf8');
}

describe('serveFolder', () => {
  it('serves the known types with no-store', async () => {
    await seedFiles();
    served = await serveFolder(web);
    const cases: ReadonlyArray<[path: string, type: string]> = [
      ['app.js', 'text/javascript; charset=utf-8'],
      ['style.css', 'text/css; charset=utf-8'],
      ['data.json', 'application/json; charset=utf-8'],
      ['site.webmanifest', 'application/manifest+json; charset=utf-8'],
      ['img.png', 'image/png'],
      ['icon.svg', 'image/svg+xml'],
      ['font.woff2', 'font/woff2'],
    ];
    const index = await fetch(`${served.baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(await index.text()).toBe('<h1>the app</h1>');
    for (const [name, type] of cases) {
      const res = await fetch(`${served.baseUrl}/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('refuses traversal attempts, unknown types and other methods', async () => {
    await seedFiles();
    // Outside the served root: a traversal that worked would return 200.
    await fsp.writeFile(path.join(root, 'secret.txt'), 'top secret', 'utf8');
    await fsp.mkdir(path.join(web, 'sub'), { recursive: true });
    served = await serveFolder(web);

    expect(await rawGet(served.port, '/%2e%2e/secret.txt')).toBe(404);
    expect(await rawGet(served.port, '/sub/%2e%2e/%2e%2e/secret.txt')).toBe(404);
    expect(await rawGet(served.port, '/..%5csecret.txt')).toBe(404);
    expect(await rawGet(served.port, '/sub/%2e%2e%5c%2e%2e/secret.txt')).toBe(404);
    expect(await rawGet(served.port, '/%00.txt')).toBe(404);
    // fetch normalizes `/../` to `/` — refusal either way, like the gateway.
    expect((await fetch(`${served.baseUrl}/../secret.txt`)).status).toBe(404);

    expect((await fetch(`${served.baseUrl}/main.ts`)).status).toBe(404);
    expect((await fetch(served.baseUrl, { method: 'POST' })).status).toBe(405);
  });

  it('404s directories without index.html and serves those with one', async () => {
    await fsp.mkdir(path.join(web, 'empty'), { recursive: true });
    await fsp.mkdir(path.join(web, 'with-index'), { recursive: true });
    await fsp.writeFile(path.join(web, 'with-index', 'index.html'), '<p>nested</p>', 'utf8');
    served = await serveFolder(web);

    expect((await fetch(`${served.baseUrl}/empty/`)).status).toBe(404);
    const slash = await fetch(`${served.baseUrl}/with-index/`);
    expect(slash.status).toBe(200);
    expect(await slash.text()).toBe('<p>nested</p>');
    expect((await fetch(`${served.baseUrl}/with-index`)).status).toBe(200);
  });

  it('close frees the port', async () => {
    await seedFiles();
    served = await serveFolder(web);
    const port = served.port;
    expect(await rawGet(port, '/')).toBe(200);
    await served.close();
    served = null;
    // A refused connect errors (ECONNREFUSED/ECONNRESET on Windows); a live
    // one would answer 200 — keep probing briefly to ride out the race.
    let freed = false;
    for (let attempt = 0; attempt < 20 && !freed; attempt++) {
      freed = await rawGet(port, '/').then(
        () => false,
        () => true,
      );
      if (!freed) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(freed).toBe(true);
  });
});

describe('phoneViewport', () => {
  it('is the phone shape with an honest mobile placeholder agent', () => {
    const viewport = phoneViewport();
    expect(viewport.width).toBe(390);
    expect(viewport.height).toBe(844);
    expect(viewport.deviceScaleFactor).toBe(2);
    expect(viewport.isMobile).toBe(true);
    expect(viewport.userAgent).toContain('Mobile');
    expect(viewport.userAgent).toContain('DreyVerify');
  });
});

/** A recording stand-in for the playwright module — proves the wiring. */
function fakePlaywright(launchImpl?: (options: unknown) => Promise<unknown>) {
  const launchCalls: unknown[] = [];
  const browser = {
    newPageCalls: [] as unknown[],
    closed: false,
    newPage: async (options: unknown): Promise<unknown> => {
      browser.newPageCalls.push(options);
      return { goto: async () => undefined };
    },
    close: async (): Promise<void> => {
      browser.closed = true;
    },
  };
  const playwright = {
    chromium: {
      launch: (options: unknown): Promise<unknown> => {
        launchCalls.push(options);
        return launchImpl !== undefined ? launchImpl(options) : Promise.resolve(browser);
      },
    },
  };
  return { playwright, browser, launchCalls };
}

describe('the playwright seam', () => {
  it('chromiumAvailable is true for a launchable module and false for a missing or broken one', async () => {
    expect(await chromiumAvailable({ playwright: fakePlaywright().playwright })).toBe(true);
    expect(await chromiumAvailable({ playwright: {} })).toBe(false);
    expect(await chromiumAvailable({ loadPlaywright: () => Promise.reject(new Error("Cannot find module 'playwright'")) })).toBe(false);
  });

  it('launchChromium launches headless and wires the phone viewport into every page', async () => {
    const fake = fakePlaywright();
    const session = await launchChromium({ playwright: fake.playwright });
    expect(fake.launchCalls).toEqual([{ headless: true }]);

    await session.newPage();
    await session.newPage();
    expect(fake.browser.newPageCalls).toEqual([{ viewport: phoneViewport() }, { viewport: phoneViewport() }]);

    await session.close();
    expect(fake.browser.closed).toBe(true);
  });

  it('launchChromium rethrows a failed load with the install hint', async () => {
    const failure = launchChromium({ loadPlaywright: () => Promise.reject(new Error("Cannot find module 'playwright'")) });
    await expect(failure).rejects.toThrow('playwright could not be loaded');
    await expect(failure).rejects.toThrow('npx playwright install chromium');
  });

  it('launchChromium wraps a refused launch with the browser hint', async () => {
    const fake = fakePlaywright(() => Promise.reject(new Error("Executable doesn't exist — run playwright install")));
    const failure = launchChromium({ playwright: fake.playwright });
    await expect(failure).rejects.toThrow('chromium did not launch');
    await expect(failure).rejects.toThrow('npx playwright install chromium');
  });
});
