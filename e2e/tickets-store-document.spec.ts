import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';
import { renderVerificationSection } from '../packages/tickets-engine/src/core/verification';
import { renderVerlaufLine } from '../packages/tickets-engine/src/core/verlauf';

/**
 * D-23, the rest: a ticket document of a dricket store shows what a files-backend
 * ticket shows — the header drawn from the board's card, the phase, the strip, the
 * proof widget, the cost table, the action bar and the folded Log — and its title edit
 * ends as one `dk put`. Everything lives on a SCRATCH store under a temp dir with a
 * home of its own (`tickets-dricket-live.spec.ts`). Skipped when `dk` is missing or
 * too old.
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
process.env['GIT_AUTHOR_NAME'] = 'Store Test';
process.env['GIT_AUTHOR_EMAIL'] = 'store@test.invalid';
process.env['GIT_COMMITTER_NAME'] = 'Store Test';
process.env['GIT_COMMITTER_EMAIL'] = 'store@test.invalid';

const dk = (args: string[]): string =>
  execFileSync(bin, args, { cwd: fs.existsSync(storeDir) ? storeDir : root, env: { ...process.env, DK_OWNER: 'terminal', DK_STORE: storeDir, DK_DATA_DIR: dataDir }, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
const git = (...args: string[]): string => execFileSync('git', args, { cwd: storeDir, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
const documentFile = path.join(storeDir, 'tickets', 't', '0000', 't-1', 'ticket.md');

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

test.beforeAll(() => {
  if (!haveDk) {
    return;
  }
  dk(['init', storeDir, 't']);
  git('checkout', '-q', 'tickets');
  dk(['add', '--unclaimed', '-m', 'Alpha: export the vault as a zip']);
  const text = fs.readFileSync(documentFile, 'utf8').replace(/\r\n/g, '\n');
  const head = /^---\n[\s\S]*?\n---\n/.exec(text)?.[0] ?? '';
  const rev = /^rev:\s*(\d+)/m.exec(text)?.[1] ?? '0';
  const body = [
    '',
    '## Description',
    '',
    'Export every note of the vault as one zip file.',
    '',
    renderVerificationSection({
      testedAt: '2026-11-04T10:00:00Z',
      tester: 'verify@box',
      environment: 'Electron 34.2.0 on win32',
      criteria: [{ command: 'The zip holds every note', passed: true, screenshot: null, note: null }],
      findings: [],
      video: null,
      videoChapters: [],
    }),
    '',
    '## Verlauf',
    '',
    renderVerlaufLine({ phase: 'plan', persona: 'paul', model: 'sonnet', tokens: '21k', cost: 0.31, dauer: '4m', ausgang: 'handed-over' }),
    '',
    '## Log',
    '',
    "- '2026-11-04T10:00:00Z' owner — created in inbox",
    "- '2026-11-04T10:05:00Z' owner — a line of the folded log",
    '',
  ].join('\n');
  const putFile = path.join(root, 'put.md');
  fs.writeFileSync(putFile, `${head}${body}`);
  dk(['put', 't-1', '-F', putFile, '--claim', '--if-version', rev]);
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

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default }',
  '  - { id: build, title: Build, handover: agent build-default }',
  '  - { id: review, title: Review, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');
const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

test.use({ seedVault: { 'tickets/_meta/pipeline.md': PIPELINE, 'tickets/_meta/repos.md': REPOS } });

test.beforeEach(({ userDataDir }) => {
  if (!haveDk) {
    return;
  }
  const dir = path.join(userDataDir, 'plugins', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ backend: 'dricket', 'dk.store': storeDir, 'dk.dataDir': dataDir, 'dk.syncSeconds': 0 }, null, 2));
});

test('a store document shows the header and widgets of a ticket, and its title edit is one dk put', async ({ page, electronApp }, testInfo) => {
  test.setTimeout(180_000);
  await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
  const panel = page.locator('.tickets-panel').filter({ visible: true });
  const row = panel.locator('.work-row[data-id="T-0001"]');
  await expect(row).toBeVisible({ timeout: 30_000 });

  await electronApp.evaluate(({ dialog }) => {
    dialog.showMessageBox = (() => Promise.resolve({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  await row.click({ button: 'right' });
  await page.getByText('Open ticket', { exact: true }).first().click();

  const editor = page.locator('app-editor').first();
  const head = editor.locator('.tickets-head');
  await expect(head).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath('store-document.png') });

  // Point 4: the header replaces the block — no pill, no raw lines.
  await expect(editor.locator('.cm-fm-pill')).toHaveCount(0);
  await expect(editor.locator('.cm-fm-line')).toHaveCount(0);
  await expect(editor.locator('.cm-content')).not.toContainText('schema_version');

  // Points 1 and 2: the model is the board's card.
  await expect(head.locator('.tickets-head-id')).toHaveText('T-0001');
  await expect(head.locator('.tickets-head-phase')).toHaveText('Inbox');
  await expect(head.locator('.tickets-issues')).toHaveCount(0);
  await expect(head.locator('.tickets-head-title')).toHaveValue('Alpha: export the vault as a zip', { timeout: 10_000 });
  await expect(head.locator('.tickets-doc-strip-host')).not.toBeEmpty();

  // Point 3: the widgets and the folded Log.
  await expect(editor.locator('.tickets-doc-proof')).toBeVisible();
  await expect(editor.locator('.tickets-doc-cost')).toBeVisible();
  await expect(editor.locator('.tickets-doc-tail')).toBeVisible();
  await expect(editor.locator('.cm-content')).not.toContainText('a line of the folded log');

  // Point 4: the raw block is the `<>` button's escape only, and folds back to the header.
  await head.locator('.tickets-head-raw').click();
  await expect(editor.locator('.cm-fm-line').first()).toBeVisible();
  await expect(editor.locator('.cm-content')).toContainText('schema_version');
  await editor.locator('.cm-fm-collapse').click();
  await expect(head).toBeVisible();
  await expect(editor.locator('.cm-fm-line')).toHaveCount(0);

  // The title edit goes into the buffer; the save is the store's `dk put`.
  const title = head.locator('.tickets-head-title');
  await title.fill('Alpha: renamed: from the header');
  await title.press('Enter');
  await expect(editor.locator('.cm-content')).toBeVisible();
  await expect.poll(() => fs.readFileSync(documentFile, 'utf8')).toContain('title: Alpha: export the vault as a zip');
  // The edit reaches the buffer when main has answered: the tab is dirty, then Ctrl+S has something to save.
  await expect(editor.locator('.actions .save')).toBeVisible();
  await page.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(documentFile, 'utf8'), { timeout: 20_000 }).toMatch(/^title: Alpha: renamed: from the header\r?$/m);
  expect(git('log', '--oneline', '-1')).toContain('put t-1');
  await expect(head.locator('.tickets-issues')).toHaveCount(0);
  await expect(editor.locator('.tickets-head-title')).toHaveValue('Alpha: renamed: from the header');
  await expect(panel.locator('.work-row[data-id="T-0001"]')).toContainText('renamed: from the header', { timeout: 20_000 });
  await page.screenshot({ path: testInfo.outputPath('store-document-renamed.png') });

  // A restored session draws the header too: the board arrives after the tab.
  await page.reload();
  await expect(page.locator('app-editor .tickets-head').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('app-editor .tickets-head-title').first()).toHaveValue('Alpha: renamed: from the header', { timeout: 10_000 });
  await expect(page.locator('app-editor .tickets-issues')).toHaveCount(0);
});
