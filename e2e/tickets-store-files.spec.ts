import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/drey';

/**
 * A dricket store's files in the app (D-27, D-25, D-28), on a SCRATCH store with a home of
 * its own (`tickets-dricket-live.spec.ts`): a new ticket opens, a checkout inside a larger
 * vault shows a ticket's header, and what a terminal's `dk` writes reaches the Files tree and
 * the open tab with nobody pressing refresh. Skipped when `dk` is missing or too old.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkf-'));
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
process.env['USERPROFILE'] = home;
process.env['HOME'] = home;
process.env['DK_OWNER'] = 'henrik';
process.env['GIT_AUTHOR_NAME'] = 'Store Test';
process.env['GIT_AUTHOR_EMAIL'] = 'store@test.invalid';
process.env['GIT_COMMITTER_NAME'] = 'Store Test';
process.env['GIT_COMMITTER_EMAIL'] = 'store@test.invalid';

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
test.afterEach(() => stopEngine());
test.afterAll(() => {
  stopEngine();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // The engine holds files open for a moment after the kill; a leftover temp dir is harmless.
  }
});

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
const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

test.use({ seedVault: { 'tickets/_meta/pipeline.md': PIPELINE, 'tickets/_meta/repos.md': REPOS } });

/** A fresh store with one unclaimed ticket, wired into the plugin's config. */
function seedStore(storeDir: string, userDataDir: string): (args: string[]) => string {
  // Outside the vault: dk refuses a working copy under another repository's tree.
  const dataDir = fs.mkdtempSync(path.join(root, 'd-'));
  fs.mkdirSync(path.dirname(storeDir), { recursive: true });
  const dk = (args: string[]): string =>
    execFileSync(bin, args, { cwd: fs.existsSync(storeDir) ? storeDir : root, env: { ...process.env, DK_OWNER: 'terminal', DK_STORE: storeDir, DK_DATA_DIR: dataDir }, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  dk(['init', storeDir, 't']);
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: storeDir, windowsHide: true, stdio: 'pipe' });
  };
  git('config', 'core.autocrlf', 'false');
  git('checkout', '-q', 'main');
  fs.appendFileSync(
    path.join(storeDir, 'dricket.toml'),
    '\n[stages]\nvalues = ["inbox", "shaping", "prioritized", "building", "ready", "done"]\ninitial = "inbox"\nterminal = ["done"]\nclaim = ["building"]\ncancelled = "cancelled"\n',
  );
  git('commit', '-q', '-am', 'stages');
  git('checkout', '-q', 'tickets');
  dk(['add', '--unclaimed', '-m', 'Alpha: export the vault as a zip']);
  const dir = path.join(userDataDir, 'plugins', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ backend: 'dricket', 'dk.store': storeDir, 'dk.dataDir': dataDir, 'dk.syncSeconds': 0 }, null, 2));
  return dk;
}

async function showBoard(page: Page): Promise<void> {
  await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
  await expect(page.locator('.tickets-panel').filter({ visible: true }).locator('.work-row[data-id="T-0001"]')).toBeVisible({ timeout: 30_000 });
}

/** Every folder of the Files tree unfolded, from the panel header's control. */
async function unfoldTree(page: Page): Promise<void> {
  await page.locator('app-panel-frame', { has: page.locator('app-files-panel') }).locator('.head').hover();
  await page.locator('button[aria-label="Expand all folders"]').click();
}

/** A row of the tree: the name, a folder's count after it. */
const treeRow = (page: Page, name: string) => page.locator('app-files-panel .node', { hasText: new RegExp(`^\\s*${name}\\s*\\d*\\s*$`) });

let dk: (args: string[]) => string = () => '';
let storeDir = '';

// The store and its config exist before the app starts: `page` launches it.
test.beforeEach(({ vaultDir, userDataDir }, testInfo) => {
  if (!haveDk) {
    return;
  }
  storeDir = testInfo.title.includes('larger vault') ? path.join(vaultDir, 'work', 'store') : path.join(fs.mkdtempSync(path.join(root, 's-')), 's');
  dk = seedStore(storeDir, userDataDir);
});

test("a new ticket opens its store document; the terminal's dk reaches the tree and the open tab", async ({ page, electronApp }) => {
  test.setTimeout(180_000);
  await showBoard(page);
  await electronApp.evaluate(({ dialog }) => {
    dialog.showMessageBox = (() => Promise.resolve({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });

  // D-27: Create opens the store's document, not the card's made-up path.
  await page.locator('app-panel-frame', { has: page.locator('.tickets-panel') }).first().locator('.head').hover();
  await page.locator('button[aria-label="New idea"]').filter({ visible: true }).first().click();
  await page.locator('.tickets-form input').first().fill('Beta: made in the app');
  await page.locator('button.tickets-form-create').click();
  const editor = page.locator('app-editor').first();
  const head = editor.locator('.tickets-head');
  await expect(head.locator('.tickets-head-id')).toHaveText('T-0002', { timeout: 30_000 });
  await expect(head.locator('.tickets-head-title')).toHaveValue('Beta: made in the app', { timeout: 10_000 });
  await expect(page.getByText('ENOENT')).toHaveCount(0);

  // D-28: the checkout's vault was added by the open; its tree shows the ticket.
  const vaultRow = page.locator('app-files-panel .vault-row', { hasText: path.basename(storeDir) });
  await expect(vaultRow).toBeVisible({ timeout: 20_000 });
  await unfoldTree(page);
  await expect(treeRow(page, 't-2')).toBeVisible({ timeout: 20_000 });
  await expect(treeRow(page, 't-3')).toHaveCount(0);

  // D-28: a terminal's new ticket reaches the tree, no refresh pressed.
  dk(['add', '--unclaimed', '-m', 'Gamma: from a terminal']);
  await expect(treeRow(page, 't-3')).toBeVisible({ timeout: 30_000 });

  // D-28, the second half: a terminal's put reaches the open, clean tab.
  const file = path.join(storeDir, 'tickets', 't', '0000', 't-2', 'ticket.md');
  const text = fs.readFileSync(file, 'utf8');
  const rev = /^rev:\s*(\d+)/m.exec(text)?.[1] ?? '0';
  const put = path.join(root, 'put.md');
  fs.writeFileSync(put, `${text.replace(/\r\n/g, '\n')}\nA line from the terminal.\n`);
  dk(['put', 't-2', '-F', put, '--claim', '--if-version', rev]);
  await expect(editor.locator('.cm-content')).toContainText('A line from the terminal.', { timeout: 30_000 });
  await expect(editor.locator('.actions .save')).toHaveCount(0);
});

test('a checkout inside a larger vault shows the ticket, not a plain note', async ({ page, electronApp }) => {
  test.setTimeout(180_000);
  await showBoard(page);
  await electronApp.evaluate(({ dialog }) => {
    dialog.showMessageBox = (() => {
      throw new Error('the checkout lies inside a vault: nothing to ask');
    }) as typeof dialog.showMessageBox;
  });

  // D-25: the document's path carries the prefix, the header and widgets still draw.
  const row = page.locator('.tickets-panel').filter({ visible: true }).locator('.work-row[data-id="T-0001"]');
  await row.click({ button: 'right' });
  await page.getByText('Open ticket', { exact: true }).first().click();
  const editor = page.locator('app-editor').first();
  const head = editor.locator('.tickets-head');
  await expect(head.locator('.tickets-head-id')).toHaveText('T-0001', { timeout: 20_000 });
  await expect(head.locator('.tickets-head-phase')).toHaveText('Inbox');
  await expect(head.locator('.tickets-head-title')).toHaveValue('Alpha: export the vault as a zip', { timeout: 10_000 });
  await expect(editor.locator('.cm-fm-pill')).toHaveCount(0);

  // D-28 in the same layout: the tree of the larger vault follows, under the prefix.
  await unfoldTree(page);
  await expect(treeRow(page, 't-1')).toBeVisible({ timeout: 20_000 });
  dk(['add', '--unclaimed', '-m', 'Beta: from a terminal']);
  await expect(treeRow(page, 't-2')).toBeVisible({ timeout: 30_000 });
});
