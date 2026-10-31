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
let editOnDesk: (id: string) => void;

// iPhone size, touch and user agent; the engine stays the suite's Chromium
// (WebKit is not part of the toolchain) — real Safari is the owner's round.
const { defaultBrowserType: _engine, ...iphone } = devices['iPhone 13'];
test.use(iphone);

test.beforeAll(async () => {
  const desk = makeDesk();
  calls = desk.calls;
  editOnDesk = desk.editOnDesk;
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

test('answers a waiting worker, follows and steers the run, and switches the fleet (R4)', async ({ page }) => {
  const errors: string[] = [];
  await pairedPage(page, errors);

  // A one-question form answers with one tap.
  await page.locator('.need-question .option', { hasText: 'Fold' }).click();
  await expect(page.locator('.toast')).toContainText('Answer sent');
  expect(calls.at(-1)).toEqual({ what: 'answer', args: [{ runId: 'run-1', answers: { q0: 'Fold' } }] });
  await expect(page.locator('.need-question')).toHaveCount(0);

  // The Runs tab lists the live run first; its view shows the transcript.
  await page.locator('.tab', { hasText: 'Runs' }).click();
  await expect(page.locator('.runrow').first()).toContainText('T-0052');
  await expect(page.locator('.runrow').nth(1)).toContainText('T-0048');
  await page.locator('.runrow', { hasText: 'T-0052' }).click();
  await expect(page.locator('.topbar-title')).toHaveText('T-0052 · Run');
  await expect(page.locator('.t-step', { hasText: 'phase-dirs.ts' })).toBeVisible();
  await expect(page.locator('.t-text')).toContainText('Two directories resolve to the inbox phase.');

  // One composer button (R8): Stop over an empty field, Send once text is
  // typed — and back to Stop after the send cleared the field.
  const composerButton = page.locator('.composer button');
  await expect(composerButton).toHaveCount(1);
  await expect(composerButton).toHaveText('Stop');
  await page.locator('.composer-field').fill('Keep the unprefixed folder as it is.');
  await expect(composerButton).toHaveText('Send');
  await composerButton.click();
  await expect(page.locator('.toast')).toContainText('Sent to the worker');
  expect(calls.at(-1)).toEqual({ what: 'send', args: [{ runId: 'run-1', text: 'Keep the unprefixed folder as it is.' }] });
  await expect(composerButton).toHaveText('Stop');

  // The master switch sits behind the header chip.
  await page.locator('.topbar .chip-btn').click();
  await page.locator('.sheet .seg button', { hasText: 'Halt' }).click();
  expect(calls.at(-1)).toEqual({ what: 'master', args: ['halted'] });
  await expect(page.locator('.topbar .chip-btn')).toHaveText('Halted');

  // A column's play/hold sits behind its head chip.
  await page.locator('.tab', { hasText: 'Board' }).click();
  await page.locator('.pchip', { hasText: /^Review/ }).click();
  await page.locator('.colhead .chip-btn', { hasText: 'Held' }).click();
  await page.locator('.sheet .seg button', { hasText: 'Play' }).click();
  expect(calls.at(-1)).toEqual({ what: 'column', args: ['review', 'playing'] });

  // Stop asks for a second tap.
  await page.goto(`http://127.0.0.1:${PORT}/#run/run-1`);
  const stop = page.locator('.composer .btn-danger');
  await stop.click();
  await expect(stop).toHaveText('Stop?');
  await stop.click();
  expect(calls.at(-1)).toEqual({ what: 'stop', args: [{ runId: 'run-1', reason: 'stopped from a device' }] });
  // An ended run keeps its composer — it reopens the run with a message
  // (the req-66 follow-up); only the Stop button is gone. This assertion
  // was stale from before that change: the composer itself stays.
  await expect(page.locator('.composer .btn-danger')).toHaveCount(0);
  await expect(page.locator('.composer textarea')).toHaveAttribute('aria-label', 'Message to reopen the run');

  expect(errors).toEqual([]);
});

test('refines a section, keeps the draft through a conflict, and edits the header (R5)', async ({ page }) => {
  const errors: string[] = [];
  await pairedPage(page, errors);
  await page.goto(`http://127.0.0.1:${PORT}/#ticket/T-0055`);
  await page.locator('.md-h', { hasText: 'Plan' }).locator('.edit').click();
  await expect(page.locator('.topbar-title')).toHaveText('Refine T-0055');
  await expect(page.locator('#ref-text')).toHaveValue("Reuse the board's move list.");

  await page.locator('#ref-text').fill('Open the move menu from the chip.');
  await page.locator('.btn-primary', { hasText: 'Save' }).click();
  await expect(page.locator('.toast')).toContainText('T-0055 saved');
  expect(calls.at(-1)).toEqual({
    what: 'refine',
    args: [{ id: 'T-0055', baseRevision: '0000000000000001', sections: { plan: 'Open the move menu from the chip.' }, header: {} }, 'owner@iphone'],
  });
  await expect(page.locator('.ticket-title')).toBeVisible();
  await expect(page.locator('.md')).toContainText('Open the move menu from the chip.');

  // The desk saves the ticket while the phone edits: the save is refused, the text survives.
  await page.locator('.md-h', { hasText: 'Plan' }).locator('.edit').click();
  await page.locator('#ref-text').fill('A second thought.');
  editOnDesk('T-0055');
  await page.locator('.btn-primary', { hasText: 'Save' }).click();
  await expect(page.locator('.banner')).toContainText('changed on the desk');
  await expect(page.locator('#ref-text')).toHaveValue('A second thought.');
  await page.locator('.banner .link', { hasText: 'Reload' }).click();
  await expect(page.locator('.banner')).toContainText('older version');
  await expect(page.locator('#ref-text')).toHaveValue('A second thought.');
  await page.locator('.btn-primary', { hasText: 'Save' }).click();
  await expect(page.locator('.toast')).toContainText('T-0055 saved');
  expect(calls.at(-1)).toMatchObject({ what: 'refine', args: [{ baseRevision: '0000000000000003', sections: { plan: 'A second thought.' } }, 'owner@iphone'] });

  // The header: priority from the ⋯ sheet.
  await page.locator('.btn-icon[aria-label="More actions"]').click();
  await page.locator('.sheet .btn', { hasText: 'Refine title' }).click();
  await page.locator('.seg button', { hasText: 'urgent' }).click();
  await page.locator('.btn-primary', { hasText: 'Save' }).click();
  expect(calls.at(-1)).toMatchObject({ what: 'refine', args: [{ id: 'T-0055', header: { priority: 'urgent' } }, 'owner@iphone'] });

  expect(errors).toEqual([]);
});

test('inserts a picked image in Capture, uploaded and embedded (R8)', async ({ page }) => {
  const errors: string[] = [];
  await pairedPage(page, errors);

  await page.locator('.tab', { hasText: 'Capture' }).click();
  await page.locator('#cap-desc').click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('.attach-row input[type="file"]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('#cap-desc')).toHaveValue('![](../attachments/img-test.png)');
  await expect(page.locator('.toast')).toContainText('Image inserted');
  expect(calls.at(-1)).toEqual({ what: 'attachment', args: [{ bytes: png, ext: 'png' }, 'owner@iphone'] });

  expect(errors).toEqual([]);
});

test('keeps the run view header pinned while the transcript scrolls (R8)', async ({ page }) => {
  const errors: string[] = [];
  await pairedPage(page, errors);

  await page.goto(`http://127.0.0.1:${PORT}/#run/run-1`);
  await expect(page.locator('.runhead .ticket-title')).toHaveText('Fold duplicate phase folders');
  await expect(page.locator('.runhead')).toContainText('started');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(0);
  const head = (await page.locator('.runhead').boundingBox())!;
  const bar = (await page.locator('.topbar').boundingBox())!;
  expect(Math.abs(head.y - (bar.y + bar.height))).toBeLessThanOrEqual(1);

  expect(errors).toEqual([]);
});

test('renders markdown in the ticket view and jumps to the run it starts (R9)', async ({ page }) => {
  const errors: string[] = [];
  await pairedPage(page, errors);
  await page.goto(`http://127.0.0.1:${PORT}/#ticket/T-0055`);

  // The Description's formatting renders, not its Markdown marks.
  await expect(page.locator('.md strong')).toHaveText('display only');
  await expect(page.locator('.md em')).toHaveText('moves');
  await expect(page.locator('.md code.ic')).toHaveText('chip → menu');
  await expect(page.locator('.md thead th')).toHaveCount(2);
  await expect(page.locator('.md tbody tr')).toHaveCount(2);
  await expect(page.locator('.md td').first()).toHaveText('Ticket view');

  // Run agent switches to the started run's transcript; back returns to the ticket.
  await page.goto(`http://127.0.0.1:${PORT}/#ticket/T-0050`);
  await page.locator('.btn-primary', { hasText: 'Run agent' }).click();
  await expect(page.locator('.topbar-title')).toHaveText('T-0050 · Run');
  expect(new URL(page.url()).hash).toBe('#run/run-2');
  await expect(page.locator('.t-text strong')).toHaveText('three bold steps');
  await page.locator('.back').click();
  await expect(page.locator('.ticket-title')).toHaveText('Blocked-by chips on cards');

  expect(errors).toEqual([]);
});

test.describe('on an iPad in landscape (R6)', () => {
  const PAD_PORT = 47866;
  const { defaultBrowserType: _padEngine, ...ipad } = devices['iPad Pro 11 landscape'];
  test.use(ipad);
  let pad: typeof service;
  let padCalls: { what: string; args: unknown[] }[];

  test.beforeAll(async () => {
    const desk = makeDesk();
    padCalls = desk.calls;
    const padStore = new Map<string, unknown>();
    pad = new RemoteService({
      config: { get: async (k: string) => padStore.get(k), set: async (k: string, v: unknown) => void padStore.set(k, v) },
      port: desk.port,
      clientDir: path.resolve('dist-electron/plugins/tickets/remote'),
      log: () => undefined,
      onChanged: () => undefined,
    });
    await pad.init();
    await pad.configure({ enabled: true, port: PAD_PORT });
  });

  test.afterAll(async () => {
    await pad.stop();
  });

  async function drag(page: Page, from: string, to: { x: number; y: number }): Promise<void> {
    const box = (await page.locator(`.kcard[data-id="${from}"]`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(450);
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.waitForTimeout(100);
    await page.mouse.up();
  }

  test('shows every column with a detail pane, and moves cards by press-and-drag', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pad.pair('iPad', false).pairing.url);
    await page.locator('.tab', { hasText: 'Board' }).click();
    await expect(page.locator('.kcol')).toHaveCount(8);
    await expect(page.locator('.detail')).toContainText('Select a ticket.');

    // A tap selects: the ticket opens beside the board.
    await page.locator('.kcard[data-id="T-0053"]').click();
    await expect(page.locator('.detail .ticket-title')).toHaveText('Phase chip moves the ticket');
    await expect(page.locator('.kcard[data-id="T-0053"]')).toHaveClass(/selected/);
    await expect(page.locator('.detail .btn-primary')).toHaveText('Approve → Build');

    // Hold, then drag into another column: a transition with the landing index.
    // The selection's reveal centers the selected column; both the source card
    // and the landing column are measured after the strip is back at the start.
    await page.locator('.kcard[data-id="T-0055"]').scrollIntoViewIfNeeded();
    const prioritized = (await page.locator('.kcol[aria-label="Prioritized"] .kcol-list').boundingBox())!;
    await drag(page, 'T-0055', { x: prioritized.x + prioritized.width / 2, y: prioritized.y + 20 });
    await expect(page.locator('.toast')).toContainText('T-0055 → Prioritized');
    expect(padCalls.at(-1)).toEqual({ what: 'move', args: [{ id: 'T-0055', from: 'inbox', to: 'prioritized', index: 0 }, 'owner@ipad'] });
    await expect(page.locator('.kcol[aria-label="Prioritized"] .kcard[data-id="T-0055"]')).toBeVisible();

    // Within a column: a reorder above the first card (Build sits off screen at first).
    await page.locator('.kcard[data-id="T-0050"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    const first = (await page.locator('.kcard[data-id="T-0052"]').boundingBox())!;
    await drag(page, 'T-0050', { x: first.x + first.width / 2, y: first.y + 4 });
    await expect(page.locator('.toast')).toContainText('T-0050 reordered');
    expect(padCalls.at(-1)).toEqual({ what: 'reorder', args: [{ phase: 'build', id: 'T-0050', index: 0 }] });

    // Moving before the hold is a scroll, never a drag.
    // The reorder's refresh rebuilds the strip; let it settle before scrolling.
    await page.waitForTimeout(400);
    const count = padCalls.length;
    await page.locator('.kcard[data-id="T-0048"]').scrollIntoViewIfNeeded();
    const card = (await page.locator('.kcard[data-id="T-0048"]').boundingBox())!;
    await page.mouse.move(card.x + 20, card.y + 20);
    await page.mouse.down();
    await page.mouse.move(card.x - 200, card.y + 20, { steps: 4 });
    await page.mouse.up();
    expect(padCalls.length).toBe(count);
    await expect(page.locator('.ghost')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});
