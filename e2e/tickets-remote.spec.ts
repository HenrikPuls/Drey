import { createRequire } from 'node:module';
import * as path from 'node:path';
import { devices, expect, test, type Page } from '@playwright/test';
import { makeDesk } from './fixtures/tickets-remote-desk';

/**
 * req-66 R3: the tickets remote's phone client, in a browser at iPhone
 * size against the built gateway (`dist-electron/plugins/tickets/`) and
 * an in-memory board behind the port — the HTTP, pairing, CSP and client
 * path is the real one; only the desk's board service is a stand-in.
 * No Electron here: the client runs in Safari, not in Drey.
 */

const require = createRequire(__filename);
const dist = path.resolve('dist-electron/plugins/tickets/main/remote');
const { RemoteService } = require(path.join(dist, 'service.js'));

const PORT = 47861;

const store = new Map<string, unknown>();
let service: { init(): Promise<void>; configure(p: unknown): Promise<unknown>; pair(n: string, r: boolean): { pairing: { url: string } }; stop(): Promise<void> };
let calls: { what: string; args: unknown[] }[];

// iPhone size, touch and user agent; the engine stays the suite's Chromium
// (WebKit is not part of the toolchain) — real Safari is the owner's round.
const { defaultBrowserType: _engine, ...iphone } = devices['iPhone 13'];
test.use(iphone);

test.beforeAll(async () => {
  const desk = makeDesk();
  calls = desk.calls;
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

async function pairedPage(page: Page, errors: string[]): Promise<void> {
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(service.pair('iPhone', false).pairing.url);
  await expect(page.locator('.topbar-title')).toHaveText('Needs you');
}

test('pairs from the link and lists what waits, then works the board', async ({ page }) => {
  const errors: string[] = [];
  await pairedPage(page, errors);
  expect(new URL(page.url()).hash).toBe('#needs');

  // Needs you: the waiting question first, the checkpoint ticket below.
  await expect(page.locator('.need-question')).toContainText('Fold them into 10-inbox?');
  await expect(page.locator('.listrow')).toContainText('T-0053');
  await expect(page.locator('.tab.on')).toContainText('Needs you');
  await expect(page.locator('.badge')).toHaveText('1');

  // Board, Build column: a left swipe moves the unblocked card on.
  await page.locator('.tab', { hasText: 'Board' }).click();
  await page.locator('.pchip', { hasText: 'Build' }).click();
  await expect(page.locator('.colhead')).toContainText('WIP 2 / 3');
  const target = page.locator('.swipe', { hasText: 'T-0050' });
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 80, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.toast')).toContainText('T-0050 → Review');
  expect(calls.at(-1)).toEqual({ what: 'move', args: [{ id: 'T-0050', from: 'build', to: 'review', index: null }, 'owner@iphone'] });
  await expect(page.locator('.swipe', { hasText: 'T-0050' })).toHaveCount(0);

  // The busy card has no swipe action; tapping opens it.
  await expect(page.locator('.swipe', { hasText: 'T-0052' }).locator('.swipe-act')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('approves a checkpoint, moves through the sheet, and captures', async ({ page }) => {
  const errors: string[] = [];
  await pairedPage(page, errors);

  await page.locator('.listrow', { hasText: 'T-0053' }).click();
  await expect(page.locator('.ticket-title')).toHaveText('Phase chip moves the ticket');
  await expect(page.locator('.md-h', { hasText: 'Acceptance criteria' })).toBeVisible();
  await expect(page.locator('.box.done')).toHaveCount(1);
  await page.locator('.seg button', { hasText: 'Log' }).click();
  await expect(page.locator('.li-log')).toContainText('created in inbox');

  await page.locator('.btn-primary', { hasText: 'Approve → Build' }).click();
  await expect(page.locator('.toast')).toContainText('T-0053 moved');
  expect(calls.at(-1)).toMatchObject({ what: 'move', args: [{ id: 'T-0053', from: 'plan-review', to: 'build' }, 'owner@iphone'] });

  // Now in Build: the primary action runs the agent; Move… offers every phase.
  await expect(page.locator('.btn-primary')).toHaveText('Run agent');
  await page.locator('.btn', { hasText: 'Move…' }).click();
  await expect(page.locator('.commit')).toHaveText('tickets: T-0053 build -> review');
  await expect(page.locator('.phase.cur')).toContainText('Build');
  await page.locator('.phase', { hasText: 'Done' }).click();
  expect(calls.at(-1)).toMatchObject({ what: 'move', args: [{ id: 'T-0053', to: 'done' }, 'owner@iphone'] });

  await page.locator('.tab', { hasText: 'Capture' }).click();
  await page.locator('#cap-title').fill('Board on the couch');
  await page.locator('.seg button', { hasText: 'high' }).click();
  await page.locator('.btn-primary', { hasText: 'Create in Inbox' }).click();
  await expect(page.locator('.ticket-title')).toHaveText('Board on the couch');
  expect(calls.at(-1)).toMatchObject({ what: 'create', args: [{ title: 'Board on the couch', priority: 'high' }, 'owner@iphone'] });

  expect(errors).toEqual([]);
});

test('a revoked or unknown token lands on the pairing screen', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/#needs`);
  await page.evaluate(() => localStorage.setItem('drey.remote.token', 'x'.repeat(43)));
  await page.reload();
  await expect(page.locator('#pair-code')).toBeVisible();
  await expect(page.locator('.issue-error')).toContainText('not paired');
});
