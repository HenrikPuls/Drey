import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/drey';

// The engine is one process per user (`~/.drey-engine/engine.lock`): a home
// of its own keeps this test off the owner's live engine and board.
const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

interface Lock {
  pid: number;
  invokePort: number;
  token: string;
}

function readLock(): Lock | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(engineHome, '.drey-engine', 'engine.lock'), 'utf8')) as Lock;
  } catch {
    return null;
  }
}

/** An outside client of the engine, like Mission Control or a phone: the invoke channel only. */
async function invokeEngine(method: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const lock = readLock();
  if (lock === null) {
    throw new Error('no engine lock');
  }
  const response = await fetch(`http://127.0.0.1:${lock.invokePort}/api/invoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lock.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
  });
  return (await response.json()) as { ok: boolean; value?: unknown; error?: string };
}

function stopEngine(): void {
  const lock = readLock();
  if (lock !== null) {
    try {
      process.kill(lock.pid);
    } catch {
      // already gone
    }
  }
}

// The engine outlives Drey by design: without the kill, closing the app hangs in teardown.
test.afterEach(() => stopEngine());

test.afterAll(() => {
  stopEngine();
  fs.rmSync(engineHome, { recursive: true, force: true });
});

/**
 * D-3 / milestone 140: an engine write reaches Drey's vault views with the
 * vault watcher OFF (the default). The engine is driven over its loopback
 * channel as an outside client would; nothing in the app is refreshed by hand.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: build, title: Build, handover: manual }',
  '  - { id: review, title: Review, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const ticket = (id: string, title: string): string =>
  [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    'repo: drey',
    'priority: normal',
    'rank: 1000',
    `branch: t/${id}`,
    "entered-inbox: '2026-11-01T09:00:00Z'",
    "entered-build: '2026-11-02T09:00:00Z'",
    '---',
    '',
    '## Description',
    '',
    'Original goal text.',
    '',
    '## Log',
    '',
  ].join('\n');

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n'),
    'tickets/20-build/T-0121.md': ticket('T-0121', 'Outline reorder'),
    'tickets/20-build/T-0126.md': ticket('T-0126', 'Stage hunks'),
  },
});

async function openFromFiles(page: Page, dir: string, file: string): Promise<void> {
  await page.getByText('tickets', { exact: true }).first().click();
  await page.getByText(dir, { exact: true }).first().click();
  await page.getByText(file, { exact: true }).first().dblclick();
}

async function waitForEngine(page: Page): Promise<void> {
  // The Work panel is what starts the plugin's board (and with it the engine).
  await page.locator('app-dock-strip button[aria-label="Show Work"]').click();
  await expect.poll(() => readLock() !== null, { timeout: 30_000 }).toBe(true);
  await expect
    .poll(async () => (await invokeEngine('snapshot', undefined).catch(() => ({ ok: false }))).ok, { timeout: 30_000 })
    .toBe(true);
}

/** What Mission Control's Refine does: read the revision, rewrite the description. */
async function engineRewritesDescription(id: string, text: string): Promise<void> {
  const read = await invokeEngine('readTicket', id);
  const revision = (read.value as { revision?: string } | undefined)?.revision;
  const refined = await invokeEngine('refineTicket', { id, baseRevision: revision, sections: { description: text }, header: {} });
  expect((refined.value as { ok?: boolean } | undefined)?.ok, JSON.stringify(refined)).toBe(true);
}

test.describe('Engine writes refresh the vault views (D-3)', () => {
  test('the Files tree and a clean open ticket tab follow an engine move and edit, watcher off', async ({ page }) => {
    await openFromFiles(page, '20-build', 'T-0121.md');
    const editor = page.locator('app-editor .cm-content').first();
    await expect(editor).toContainText('Original goal text.', { timeout: 15_000 });
    await waitForEngine(page);

    // An in-place edit by the engine: the clean tab reloads from disk.
    await engineRewritesDescription('T-0121', 'Engine rewrote the goal.');
    await expect(editor).toContainText('Engine rewrote the goal.', { timeout: 15_000 });

    // A move into another phase folder: the tree shows the new folder and file
    // (the old one vanishes) without any refresh.
    const moved = await invokeEngine('transition', { id: 'T-0126', from: 'build', to: 'review' });
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    await page.getByText('30-review', { exact: true }).first().click({ timeout: 15_000 });
    await expect(page.getByText('T-0126.md', { exact: true })).toHaveCount(1, { timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('engine-refresh-tree.png') });
  });

  test('a dirty ticket tab keeps its unsaved text and is marked "Changed on disk"', async ({ page }) => {
    await openFromFiles(page, '20-build', 'T-0121.md');
    const editor = page.locator('app-editor .cm-content').first();
    await expect(editor).toContainText('Original goal text.', { timeout: 15_000 });
    await waitForEngine(page);

    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('MY UNSAVED NOTE');

    await engineRewritesDescription('T-0121', 'Engine rewrote the goal.');

    await expect(page.getByRole('button', { name: /Changed on disk/i })).toBeVisible({ timeout: 15_000 });
    await expect(editor).toContainText('UNSAVED NOTE');
    await expect(editor).not.toContainText('Engine rewrote the goal.');
    await page.screenshot({ path: test.info().outputPath('engine-refresh-dirty.png') });
  });
});
