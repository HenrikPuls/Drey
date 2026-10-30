import { createRequire } from 'node:module';
import * as path from 'node:path';
import { devices, expect, test, type Page } from '@playwright/test';
import { makeDesk } from './fixtures/tickets-remote-desk';

/**
 * T-0053: the phone client paints only what changed. The page's body is
 * rebuilt (`main.replaceChildren`) only when the built view differs from
 * the one on screen — a full repaint is counted by a MutationObserver on
 * `main` (installed through addInitScript, before the app creates the
 * element). The desk is the same in-memory stand-in as the req-66 spec;
 * only the guard is under test here, on its own service port.
 */

const require = createRequire(__filename);
const dist = path.resolve('dist-electron/plugins/tickets/main/remote');
const { RemoteService } = require(path.join(dist, 'service.js'));

const PORT = 47862;

const store = new Map<string, unknown>();
let service: { init(): Promise<void>; configure(p: unknown): Promise<unknown>; pair(n: string, r: boolean): { pairing: { url: string } }; stop(): Promise<void> };
let touchFleet: (patch: Record<string, unknown>) => void;
let moveOnDesk: (id: string, from: string, to: string) => Promise<unknown>;

// iPhone size, touch and user agent; the engine stays the suite's Chromium.
const { defaultBrowserType: _engine, ...iphone } = devices['iPhone 13'];
test.use(iphone);

test.beforeAll(async () => {
  const desk = makeDesk();
  touchFleet = desk.touchFleet;
  moveOnDesk = (id, from, to) => desk.port.move({ id, from, to }, 'owner@desk');
  service = new RemoteService({
    config: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
    port: desk.port,
    clientDir: path.resolve('dist-electron/plugins/tickets/remote'),
    log: () => undefined,
    onChanged: () => undefined,
  });
  await service.init();
  await service.configure({ enabled: true, port: PORT });
});

test.afterAll(async () => {
  await service.stop();
});

/** Counts the paints of `main` — one MutationObserver batch per full repaint. */
async function countPaints(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as { __paints?: number };
    const boot = new MutationObserver(() => {
      const main = document.querySelector('main');
      if (main === null) {
        return;
      }
      boot.disconnect();
      w.__paints = 0;
      new MutationObserver(() => {
        w.__paints = (w.__paints ?? 0) + 1;
      }).observe(main, { childList: true });
    });
    boot.observe(document, { childList: true, subtree: true });
  });
}

const paints = (page: Page): Promise<number> => page.evaluate(() => (window as { __paints?: number }).__paints ?? -1);

/** Opens a paired page and waits until the event stream is connected (the chip goes live). */
async function pairedPage(page: Page, errors: string[]): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await countPaints(page);
  await page.goto(service.pair('iPhone', false).pairing.url);
  await expect(page.locator('.topbar-title')).toHaveText('Needs you');
  await expect(page.locator('.topbar .chip-btn')).toContainText('Running');
}

test('startup paints the page exactly once, online or not', async ({ page }) => {
  const errors: string[] = [];
  // The stream stays away at first, so the first paint is deterministically
  // offline — its catch-up refresh (250 ms after connect) must not repaint.
  await page.route('**/api/events', async (route) => {
    await page.waitForTimeout(600);
    await route.continue();
  });
  await pairedPage(page, errors);
  await page.waitForTimeout(1000);
  expect(await paints(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('a live run\'s tick, which the page does not render, paints nothing', async ({ page }) => {
  const errors: string[] = [];
  await pairedPage(page, errors);
  await page.waitForTimeout(1000);
  const before = await paints(page);
  touchFleet({ activity: 'reading views.ts', tokensIn: 51_004, contextTokens: 44_000 });
  await page.waitForTimeout(1200);
  expect(await paints(page)).toBe(before);
  // The question is still on the page — the skip was not a blank.
  await expect(page.locator('.need-question')).toContainText('Fold them into 10-inbox?');
  expect(errors).toEqual([]);
});

test('a visible board change still paints', async ({ page }) => {
  const errors: string[] = [];
  await pairedPage(page, errors);
  await page.locator('.tab', { hasText: 'Board' }).click();
  await expect(page.locator('.colhead')).toContainText('1 tickets');
  const before = await paints(page);
  await moveOnDesk('T-0055', 'inbox', 'prioritized');
  await expect(page.locator('.view .empty')).toHaveText('No tickets in this column.');
  expect(await paints(page)).toBe(before + 1);
  expect(errors).toEqual([]);
});
