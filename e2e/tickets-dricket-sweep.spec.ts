import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * The sweep of 2026-11-05 (roadmap D-11 to D-22) in the RUNNING app, on a SCRATCH
 * dricket store seeded like `scripts/verify-dricket.ps1`. Everything lives under a
 * temp dir with a home of its own; the owner's `~/.drey-engine`, board and
 * `drey-tickets` repository are never touched. Skipped when `dk` is missing.
 */
const bin = process.env['DREY_DK_BIN'] ?? 'dk';

function dkVersionOk(): boolean {
  try {
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    const m = /version:\s*v?(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m !== null && (Number(m[1]) > 0 || Number(m[2]) > 6 || (Number(m[2]) === 6 && Number(m[3]) >= 2));
  } catch {
    return false;
  }
}
const haveDk = dkVersionOk();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dks-'));
const home = path.join(root, 'home');
const storeDir = path.join(root, 's');
const dataDir = path.join(root, 'd');
fs.mkdirSync(home, { recursive: true });
process.env['USERPROFILE'] = home;
process.env['HOME'] = home;
process.env['DK_OWNER'] = 'henrik';
process.env['GIT_AUTHOR_NAME'] = 'Sweep Test';
process.env['GIT_AUTHOR_EMAIL'] = 'sweep@test.invalid';
process.env['GIT_COMMITTER_NAME'] = 'Sweep Test';
process.env['GIT_COMMITTER_EMAIL'] = 'sweep@test.invalid';

const dk = (args: string[], owner = 'henrik'): string =>
  execFileSync(bin, args, { cwd: fs.existsSync(storeDir) ? storeDir : root, env: { ...process.env, DK_OWNER: owner, DK_STORE: storeDir, DK_DATA_DIR: dataDir }, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
const git = (...args: string[]): string => execFileSync('git', args, { cwd: storeDir, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
const shown = (id: string): string => (JSON.parse(dk(['show', id, '--json'])) as { data: { content: string } }).data.content;

function stopEngine(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(home, '.drey-engine', 'engine.lock'), 'utf8')) as { pid?: number };
    if (typeof lock.pid === 'number') {
      process.kill(lock.pid);
    }
  } catch {
    // no engine was started, or it is already gone
  }
}

test.skip(!haveDk, 'dk >= 0.6.2 not found');

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: shaping, title: Shaping, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: building, title: Building, claim: true, handover: agent build-default }',
  '  - { id: ready, title: Ready to try, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');
const REPOS = ['---', 'repos:', '  scratch:', '    url: https://example.invalid/scratch.git', '    branch: main', '---', ''].join('\n');

test.beforeAll(() => {
  if (!haveDk) {
    return;
  }
  dk(['init', storeDir, 't']);
  git('config', 'core.autocrlf', 'false');
  git('checkout', '-q', 'main');
  fs.appendFileSync(
    path.join(storeDir, 'dricket.toml'),
    '\n[stages]\nvalues = ["inbox", "shaping", "prioritized", "building", "ready", "done"]\ninitial = "inbox"\nterminal = ["done"]\nclaim = ["building"]\ncancelled = "cancelled"\n',
  );
  git('commit', '-q', '-am', 'stages');
  git('checkout', '-q', 'tickets');
  dk(['add', '--unclaimed', '-m', 'Export the vault as a zip']);
  dk(['add', '--unclaimed', '-m', 'Spellcheck for daily notes']);
  dk(['add', '--unclaimed', '-m', 'Pin tabs to the left']);
  dk(['add', '--unclaimed', '-m', 'Fix the tag colour']);
  dk(['add', '--unclaimed', '-m', 'Release notes']);
  dk(['add', '--unclaimed', '-m', 'Rename a folder without losing links']);
  dk(['comment', 't-1', '-m', 'Decision needed: zip everything, or only the open notes?']);
  dk(['comment', 't-2', '-m', 'The dictionary ships with the app.']);
  for (const [id, stage] of [['t-2', 'ready'], ['t-3', 'prioritized'], ['t-6', 'done']] as const) {
    dk(['claim', id, '--size', 'S', '--kind', 'human'], 'seed-agent@scratch');
    dk(['release', id, '--stage', stage, '-m', `Seeded into ${stage}.`], 'seed-agent@scratch');
  }
});

test.afterEach(() => stopEngine());

test.afterAll(() => {
  stopEngine();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // The engine holds files open for a moment after the kill; a leftover temp dir is harmless.
  }
});

test.use({ seedVault: { 'tickets/_meta/pipeline.md': PIPELINE, 'tickets/_meta/repos.md': REPOS } });

test.beforeEach(({ userDataDir }) => {
  if (!haveDk) {
    return;
  }
  const dir = path.join(userDataDir, 'plugins', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ backend: 'dricket', 'dk.store': storeDir, 'dk.dataDir': dataDir, 'dk.syncSeconds': 0 }, null, 2));
});

test('the sweep defects on the store', async ({ page, electronApp }, testInfo) => {
  test.setTimeout(240_000);
  const tabs = page.locator('[role="tablist"][aria-label="Views"] [role="tab"]');
  await expect(tabs).toHaveText(['Notes', 'Work', 'Crew'], { timeout: 30_000 });
  await tabs.filter({ hasText: 'Work' }).click();
  const panel = page.locator('.tickets-panel').filter({ visible: true });
  const row = (id: string) => panel.locator(`.work-row[data-id="${id}"]`);
  await expect(row('T-0002')).toBeVisible({ timeout: 30_000 });
  const shot = async (name: string): Promise<void> => {
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  };

  // D-12: a "Decision needed" comment is a Needs-you row (board 7a: the row names the kind, the question is in the thread).
  await expect(panel.locator('.work-group-needs').locator('.work-row[data-id="T-0001"]')).toContainText(/decision/i);

  // D-11: the menu offers the store's vocabulary, and the choice lands as one put.
  await row('T-0003').hover();
  await row('T-0003').locator('button[aria-label="More"], .work-row-more').first().click();
  await page.locator('.tickets-menu-item.has-sub', { hasText: 'Priority' }).hover();
  const priorities = page.locator('.tickets-submenu .tickets-menu-item');
  await expect(priorities).toHaveText(['Critical', 'High', 'Normal', 'Low'].map((label) => new RegExp(`${label}$`)));
  await priorities.first().click();
  await expect.poll(() => shown('t-3')).toMatch(/^priority: critical$/m);

  // D-14 + D-15: two quick opens ask once, in front of the app, and the tab says which ticket it is.
  await electronApp.evaluate(({ dialog }) => {
    const calls: unknown[][] = [];
    (globalThis as unknown as { promptCalls: unknown[][] }).promptCalls = calls;
    dialog.showMessageBox = ((...args: unknown[]) => {
      calls.push(args);
      return new Promise((resolve) => setTimeout(() => resolve({ response: 0, checkboxChecked: false }), 1_500));
    }) as typeof dialog.showMessageBox;
  });
  await row('T-0003').click();
  await row('T-0003').click();
  const tab = page.locator('app-tab-bar').filter({ visible: true }).getByText('T-0003 · Pin tabs to the left', { exact: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  const asked = await electronApp.evaluate(() => {
    const calls = (globalThis as unknown as { promptCalls: unknown[][] }).promptCalls;
    return { count: calls.length, parented: calls[0]?.length === 2 };
  });
  expect(asked).toEqual({ count: 1, parented: true });
  await shot('tab-title');

  // D-21: a live run opens the thread; the composer stays above the Capacity band at the Work view's default sizes.
  const pushRuns = (runs: readonly Record<string, unknown>[]): Promise<void> =>
    electronApp.evaluate(
      ({ BrowserWindow }, data) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('plugin:event', data);
        }
      },
      { pluginId: 'tickets', event: 'fleet-changed', data: { runs, chain: null } },
    );
  const run = {
    id: 'r-1', ticketId: 'T-0002', persona: null, provider: 'opencode', model: 'qwen3-coder', column: 'ready', phase: 'ready',
    state: 'running', pid: 4242, startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), endedAt: null, sessionRef: 'ses-1',
    tokensIn: 100, tokensOut: 10, costUsd: null, lastActivity: new Date().toISOString(), steerCount: 0, worktreePath: '',
  };
  const composer = page.locator('.tickets-thread .tickets-composer-box').filter({ visible: true }).first();
  await expect
    .poll(
      async () => {
        await pushRuns([run]);
        await row('T-0002').click();
        return composer.isVisible();
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const thread = page.locator('.tickets-thread-steps').filter({ visible: true });
  await expect(thread).toBeVisible();

  // D-22 + D-12: the run gone, no empty step row above "No run…", and the ticket's comments in the thread.
  await expect
    .poll(
      async () => {
        await pushRuns([]);
        return thread.locator('.tickets-step-open').isVisible();
      },
      { timeout: 15_000 },
    )
    .toBe(false);
  await expect(thread.getByText('No run on this ticket yet.')).toBeVisible();
  await shot('thread-no-run');

  // D-21: the Ready to try card is up, and the composer still stays inside its pane at the default sizes.
  await expect(page.locator('.tickets-thread .tickets-ready-body-host').filter({ visible: true })).toBeVisible({ timeout: 15_000 });
  // Nothing clips a pane's content, so a thread taller than its pane paints over the band below it.
  const fit = await composer.evaluate((node) => ({
    composer: node.getBoundingClientRect().bottom,
    pane: node.closest('app-pane-leaf')?.getBoundingClientRect().bottom ?? 0,
    ready: node.closest('.tickets-thread')?.querySelector('.tickets-ready-body-host')?.getBoundingClientRect().height ?? 0,
  }));
  console.log('[sweep] D-21', JSON.stringify(fit));
  await shot('thread-with-run');
  expect(fit.ready).toBeGreaterThan(0);
  expect(fit.composer).toBeLessThanOrEqual(fit.pane + 1);

  // D-12: the ticket's comments are in the thread.
  await expect(thread).toContainText('The dictionary ships with the app.');
  await shot('thread-comments');

  // D-13: archived from the board, the open thread stays readable, comments included.
  await row('T-0002').hover();
  await row('T-0002').locator('button[aria-label="More"], .work-row-more').first().click();
  await page.locator('.tickets-menu-item', { hasText: 'Archive' }).click();
  await page.locator('.tickets-menu-item', { hasText: 'click again' }).click();
  await expect.poll(() => shown('t-2')).toMatch(/^labels: .*archived/m);
  await expect(row('T-0002')).toHaveCount(0, { timeout: 15_000 });
  const threadTitle = page.locator('.tickets-thread-title').filter({ visible: true });
  await expect(threadTitle).toHaveText('Spellcheck for daily notes', { timeout: 15_000 });
  await expect(thread).toContainText('The dictionary ships with the app.');
  await shot('thread-after-archive');

  // D-13: it and the ticket that reached Done from a terminal are under Done this week and open from there.
  const done = panel.locator('.work-group-done');
  await expect(done).toContainText('Done this week');
  await done.locator('button, [role="button"]').first().click();
  await expect(done).toContainText('Spellcheck for daily notes');
  await done.getByText('Rename a folder without losing links').click();
  await expect(page.locator('app-tab-bar').filter({ visible: true }).getByText('T-0006 · Rename a folder without losing links', { exact: true })).toBeVisible({ timeout: 15_000 });
  await shot('done-this-week');
  // D-15: the Assistant's chip calls the document what its tab does.
  await expect(page.locator('.composer-chips .chip-name').filter({ visible: true }).first()).toHaveText('T-0006 · Rename a folder without losing links', { timeout: 15_000 });
});
