import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * E14-8: change detection in the RUNNING app, on a SCRATCH dricket store. A
 * foreign writer (`dk` from a terminal) must show up on the board without a
 * refresh; the board's own write moves, a burst of foreign writes and the
 * editor's save of a ticket document must all land too. Everything lives under
 * a temp dir with a home of its own: the owner's `~/.drey-engine`, board and
 * `drey-tickets` repository are never touched (the engine home trick of
 * `desk-board-team.spec.ts`). Skipped when `dk` is missing or too old.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkl-'));
const home = path.join(root, 'home');
const storeDir = path.join(root, 's');
const dataDir = path.join(root, 'd');
const bareDir = path.join(root, 'r.git');
const cloneDir = path.join(root, 'c');
fs.mkdirSync(home, { recursive: true });
process.env['USERPROFILE'] = home;
process.env['HOME'] = home;
process.env['DK_OWNER'] = 'henrik';
process.env['GIT_AUTHOR_NAME'] = 'Live Test';
process.env['GIT_AUTHOR_EMAIL'] = 'live@test.invalid';
process.env['GIT_COMMITTER_NAME'] = 'Live Test';
process.env['GIT_COMMITTER_EMAIL'] = 'live@test.invalid';

const dk = (args: string[], owner = 'terminal'): string =>
  execFileSync(bin, args, { cwd: fs.existsSync(storeDir) ? storeDir : root, env: { ...process.env, DK_OWNER: owner, DK_STORE: storeDir, DK_DATA_DIR: dataDir }, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
const remoteDk = (args: string[], owner = 'terminal'): string =>
  execFileSync(bin, args, { cwd: root, env: { ...process.env, DK_OWNER: owner, DK_STORE: `${bareDir}#tickets`, DK_PROJECT: 't', DK_DATA_DIR: path.join(root, 'rd') }, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
const git = (...args: string[]): string => execFileSync('git', args, { cwd: storeDir, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });

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
  dk(['add', '--unclaimed', '-m', 'Bravo: spellcheck the daily note']);
  dk(['add', '--unclaimed', '-m', 'Charlie: pin tabs to the left']);
  // the remote store: a bare repository, a clone as the checkout (not the store itself)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'tickets', bareDir], { windowsHide: true, stdio: 'pipe' });
  remoteDk(['init', `${bareDir}#tickets`, 't']);
  remoteDk(['add', '--unclaimed', '-m', 'Remote Alpha: first ticket on the remote']);
  remoteDk(['add', '--unclaimed', '-m', 'Remote Bravo: second ticket on the remote']);
  execFileSync('git', ['clone', '-q', '-b', 'tickets', bareDir, cloneDir], { windowsHide: true, stdio: 'pipe' });
});

// The engine outlives Drey by design; kill it before the app's own teardown or that waits a minute for it.
test.afterEach(() => stopEngine());

test.afterAll(() => {
  stopEngine();
  if ((process.env['DKL_KEEP'] ?? '') !== '') {
    console.log('[live] kept', root);
    return;
  }
  // The engine holds files open for a moment after the kill; a leftover temp dir is harmless.
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
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

test.beforeEach(({ userDataDir }, testInfo) => {
  if (!haveDk) {
    return;
  }
  const dir = path.join(userDataDir, 'plugins', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(
    testInfo.title.includes('remote')
      ? { backend: 'dricket', 'dk.store': `${bareDir}#tickets`, 'dk.dataDir': path.join(root, 'ed'), 'dk.checkout': cloneDir, 'dk.syncSeconds': 2 }
      : { backend: 'dricket', 'dk.store': storeDir, 'dk.dataDir': dataDir, 'dk.syncSeconds': 0 },
    null,
    2,
  ));
});

test('a foreign dk write, a burst, own moves and the editor save all reach the board', async ({ page, electronApp }, testInfo) => {
  test.setTimeout(240_000);
  const timings: string[] = [];
  const note = (line: string): void => {
    timings.push(line);
    console.log(`[live] ${line}`);
  };
  await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
  for (const other of ['Calendar', 'Files', 'Open windows']) {
    await page.locator(`app-dock-strip button[aria-label="Hide ${other}"]`).click();
  }
  const panel = page.locator('.tickets-panel').filter({ visible: true });
  const row = (id: string) => panel.locator(`.work-row[data-id="${id}"]`);
  const seen = async (id: string, since: number, label: string): Promise<void> => {
    await expect(row(id)).toBeVisible({ timeout: 20_000 });
    note(`${label}: ${id} on the board after ${Date.now() - since} ms`);
  };

  // 1. the seeded store shows
  await expect(row('T-0001')).toBeVisible({ timeout: 30_000 });
  await expect(row('T-0003')).toBeVisible();
  await expect(row('T-0004')).toHaveCount(0);

  // 2. a foreign `dk add` from a terminal shows up without any refresh
  let since = Date.now();
  dk(['add', '--unclaimed', '-m', 'Delta: foreign ticket from a terminal']);
  await seen('T-0004', since, 'foreign dk add');

  // 3. a burst: eight adds back to back, every one ends up on the board
  since = Date.now();
  for (let i = 0; i < 8; i++) {
    dk(['add', '--unclaimed', '-m', `Burst ${i + 1}: rapid foreign write`]);
  }
  await seen('T-0012', since, 'burst of 8 dk adds (last one)');
  await expect(panel.locator('.work-group-ideas')).toContainText('12');
  await panel.getByText(/^\d+ more$/).click();
  for (let n = 1; n <= 12; n++) {
    await expect(row(`T-${String(n).padStart(4, '0')}`)).toBeVisible();
  }

  // 4. a foreign dk put (rewrites a whole ticket) changes a title already on the board
  const current = dk(['show', 't-2']);
  const rev = /^rev:\s*(\d+)/m.exec(current)?.[1];
  note(`dk show T-0002 rev ${rev ?? '?'}`);
  const body = fs.readFileSync(path.join(storeDir, 'tickets', 't', '0000', 't-2', 'ticket.md'), 'utf8').replace(/^title: .*$/m, 'title: Bravo: renamed by a foreign dk put');
  const putFile = path.join(root, 'put.md');
  fs.writeFileSync(putFile, body);
  since = Date.now();
  dk(['put', 't-2', '-F', putFile, '--claim', ...(rev === undefined ? [] : ['--if-version', rev])]);
  await expect(row('T-0002')).toContainText('renamed by a foreign dk put', { timeout: 20_000 });
  note(`foreign dk put: new title on the board after ${Date.now() - since} ms`);
  await panel.screenshot({ path: testInfo.outputPath('board-after-foreign-writes.png') });

  // 5. the board's own write (setPriority is one `dk put`) and a foreign write right behind it
  const own = await page.evaluate(() => window.dreyApi.invokePlugin('tickets', 'setPriority', { id: 'T-0003', priority: 'high' }));
  note(`own setPriority -> ${JSON.stringify(own)}`);
  expect((own as { ok?: boolean }).ok).toBe(true);
  since = Date.now();
  dk(['add', '--unclaimed', '-m', 'Echo: foreign write right behind an own write']);
  await seen('T-0013', since, 'foreign add right behind own write');
  expect(dk(['show', 't-3'])).toMatch(/priority:\s*high/);

  // 6. the editor: a ticket document opens from the checkout and its save is a dk put
  await electronApp.evaluate(({ dialog }) => {
    dialog.showMessageBox = (() => Promise.resolve({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  await row('T-0001').click({ button: 'right' });
  await page.getByText('Open ticket', { exact: true }).first().click();
  await expect(page.locator('app-editor .tickets-head-id').first()).toHaveText('T-0001', { timeout: 20_000 });
  const editor = page.locator('app-editor .cm-content').first();
  // Milestone 185: the `## Log` holding `terminal add t-1` opens folded.
  await expect(page.locator('app-editor .cm-foldPlaceholder').first()).toBeVisible();
  await expect(editor).not.toContainText('terminal add t-1');
  const putsOfT1 = (): number => git('log', '--oneline', '--grep=put t-1').split('\n').filter((line) => line !== '').length;
  const putsBefore = putsOfT1();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nEdited in Drey: the editor save is a dk put.\n');
  await page.keyboard.press('Control+S');
  await expect.poll(() => fs.readFileSync(path.join(storeDir, 'tickets', 't', '0000', 't-1', 'ticket.md'), 'utf8'), { timeout: 20_000 }).toContain('Edited in Drey');
  // One save is one `dk put`, and the folded Log is written back whole.
  await expect.poll(putsOfT1, { timeout: 20_000 }).toBe(putsBefore + 1);
  expect(fs.readFileSync(path.join(storeDir, 'tickets', 't', '0000', 't-1', 'ticket.md'), 'utf8')).toContain('terminal add t-1');
  note(`editor save landed in the store; dk log: ${git('log', '--oneline', '-3').trim().split('\n').join(' | ')}`);
  await page.screenshot({ path: testInfo.outputPath('window-ticket-document.png') });

  // 7. the store checkout (a vault now) is flagged plugin-managed: Source control refuses to write there
  const states = (await page.evaluate(() => window.dreyApi.invokePlugin('git', 'status', { refresh: true }))) as { root?: string; managedBy: string | null }[];
  note(`git status per vault: ${JSON.stringify(states.map((v) => [path.basename(v.root ?? '-'), v.managedBy]))}`);
  const checkoutState = states.find((v) => path.resolve(v.root ?? '-').toLowerCase() === path.resolve(storeDir).toLowerCase());
  expect(checkoutState?.managedBy).toBe('Tickets');

  testInfo.attach('timings.txt', { body: timings.join('\n') });
});

test('a remote store: the periodic dk sync brings a foreign push to the board, own moves push', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
  for (const other of ['Calendar', 'Files', 'Open windows']) {
    await page.locator(`app-dock-strip button[aria-label="Hide ${other}"]`).click();
  }
  const panel = page.locator('.tickets-panel').filter({ visible: true });
  const row = (id: string) => panel.locator(`.work-row[data-id="${id}"]`);
  await expect(row('T-0001')).toBeVisible({ timeout: 30_000 });
  await expect(row('T-0002')).toBeVisible();

  // a push from "another machine" (dk straight at the remote) arrives through the periodic sync
  let since = Date.now();
  remoteDk(['add', '--unclaimed', '-m', 'Remote Charlie: pushed from elsewhere']);
  await expect(row('T-0003')).toBeVisible({ timeout: 30_000 });
  console.log(`[live] remote: foreign push on the board after ${Date.now() - since} ms (sync every 2 s)`);
  expect(git('-C', cloneDir, 'log', '--oneline', '-1')).toBeDefined();

  // the board's own write pushes to the remote
  const own = await page.evaluate(() => window.dreyApi.invokePlugin('tickets', 'setPriority', { id: 'T-0002', priority: 'high' }));
  expect((own as { ok?: boolean }).ok).toBe(true);
  since = Date.now();
  await expect.poll(() => execFileSync('git', ['-C', bareDir, 'log', '--oneline', '-3', 'tickets'], { encoding: 'utf8', windowsHide: true }), { timeout: 20_000 }).toContain('put t-2');
  console.log(`[live] remote: own write on the remote after ${Date.now() - since} ms`);
  await panel.screenshot({ path: testInfo.outputPath('board-remote-store.png') });
});
