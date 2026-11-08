import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * The Persona page on a dricket store (owner ruling on the 7k measure
 * sheet: confirm, not assume): tickets live in the store, the persona
 * files stay in the checkout vault, so the page reads `prompt.md` over the
 * vault and `personaPatch` writes it there. A scratch store, a home of its
 * own; skipped when `dk` is missing.
 */
const bin = process.env['DREY_DK_BIN'] ?? 'dk';

function dkOk(): boolean {
  try {
    execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

test.skip(!dkOk(), 'dk not found');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkp-'));
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

test.beforeAll(() => {
  const env = { ...process.env, DK_OWNER: 'terminal', DK_STORE: storeDir, DK_DATA_DIR: dataDir };
  execFileSync(bin, ['init', storeDir, 't'], { cwd: root, env, stdio: 'pipe', windowsHide: true });
  execFileSync(bin, ['add', '--unclaimed', '-m', 'A ticket only the store has'], { cwd: storeDir, env, stdio: 'pipe', windowsHide: true });
});

test.afterAll(() => {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(home, '.drey-engine', 'service.lock'), 'utf8')) as { pid?: number };
    if (typeof lock.pid === 'number') {
      process.kill(lock.pid);
    }
  } catch {
    // no engine was started, or it is already gone
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // The engine holds files open for a moment after the kill; a leftover temp dir is harmless.
  }
});

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': ['---', 'phases:', '  - { id: inbox, title: Inbox, handover: manual }', '  - { id: build, title: Build, handover: agent build-default, persona: ben }', '  - { id: done, title: Done, handover: none }', '---', 'The phases.', ''].join('\n'),
    'tickets/_meta/repos.md': ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n'),
    'tickets/_meta/personas/ben/persona.md': ['---', 'title: Ben', 'role: builder', 'worker: opencode', 'models:', '  default: qwen3-coder', '  pool: [qwen3-coder]', '  router: off', "color: '#8ecbef'", 'skills: []', '---', 'Who Ben is.', ''].join('\n'),
    'tickets/_meta/personas/ben/prompt.md': 'You are Ben, on a store.\n',
  },
  appConfig: { plugins: { disabled: ['sample', 'templates', 'browser', 'drawio', 'ocr', 'meeting'] }, spellcheck: { enabled: false } },
});

test.beforeEach(({ userDataDir, vaultDir }) => {
  execFileSync('git', ['init', '-q'], { cwd: vaultDir, windowsHide: true });
  const dir = path.join(userDataDir, 'plugins', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ backend: 'dricket', 'dk.store': storeDir, 'dk.dataDir': dataDir, 'dk.syncSeconds': 0 }, null, 2));
});

test('reads and writes prompt.md in the checkout vault', async ({ page, vaultDir }) => {
  test.setTimeout(120_000);
  await expect(page.locator('app-titlebar [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+2');
  // The board really runs on the store: this ticket exists nowhere else.
  await expect(page.locator('.tickets-panel').filter({ visible: true })).toContainText('A ticket only the store has', { timeout: 30_000 });
  await page.locator('app-panel-frame', { has: page.locator('.tickets-panel') }).filter({ visible: true }).locator('.head').hover();
  await page.locator('button[aria-label="More actions"]:visible').click({ force: true });
  await page.getByRole('menuitem', { name: 'Crew', exact: true }).click();
  await page.locator('.desk-team [data-persona="ben"]').first().click();
  await page.locator('.desk-detail-head .persona-edit-btn').click();
  const body = page.locator('.persona-page').filter({ visible: true });
  await expect(body.locator('.persona-text')).toHaveValue('You are Ben, on a store.\n', { timeout: 15_000 });
  await body.locator('.persona-text').fill('Changed on a store.\n');
  await body.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(body.locator('.persona-head > .persona-muted')).toHaveText('Saved', { timeout: 15_000 });
  expect(fs.readFileSync(path.join(vaultDir, 'tickets', '_meta', 'personas', 'ben', 'prompt.md'), 'utf8')).toBe('Changed on a store.\n');
  // Nothing of the persona landed in the store.
  expect(execFileSync('git', ['log', '--all', '--name-only', '--format='], { cwd: storeDir, encoding: 'utf8', windowsHide: true })).not.toContain('prompt.md');
});
