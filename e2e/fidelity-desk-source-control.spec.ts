import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';
import {
  DESK_CONFIG,
  DESK_SEED,
  OUT,
  arrangeDocks,
  compareWithBoard,
  ensureOut,
  openDeskTabs,
  panelFrame,
  pushFleet,
  pushPluginEvent,
  saveLayout,
  shootPanel,
  sizeWindow,
} from './fixtures/fidelity-desk';

/**
 * NOT a regression suite: puts the built app in the states boards 9d
 * `DeskSourceControl` and `DeskSourceControlParts` show (req-162) and
 * takes the screenshots the fidelity checklist asks for. Opt-in:
 *
 *   . .\env.ps1
 *   $env:DREY_FIDELITY_SHOTS = '1'
 *   npm run e2e:run -- fidelity-desk-source-control
 *
 * Output under `test-results/fidelity/`: `DeskSourceControl.png`
 * (1440x900, scale factor 1, + compare.html captures) and one crop of the
 * panel per Parts state (`DeskSourceControl.<state>.png`). The vault is a
 * scratch repository with a bare remote beside it: two local commits not
 * pushed, one on the remote to pull, five changes.
 */

const RUN = !!process.env['DREY_FIDELITY_SHOTS'];
test.skip(!RUN, 'set DREY_FIDELITY_SHOTS=1 -- the board 9d screenshots');

const DAY = 86_400_000;

function at(daysAgo: number, hour: number, minute: number): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const seed: Record<string, string> = {
  ...DESK_SEED,
  '.gitignore': '.drafts/\n',
  'projects/brand-guide.md': '# Brand guide\n\nColours and type.\n',
  'projects/website-relaunch.md': '# Website relaunch\n\nThe plan.\n',
  'projects/old-plan.md': '# Old plan\n\nSuperseded.\n',
};

test.use({
  seedVault: seed,
  extraVaults: { archive: { 'readme.md': '# Archive\n' } },
  launchArgs: ['--force-device-scale-factor=1'],
  appConfig: DESK_CONFIG,
});

test('board 9d: Source control in the Work view, then every Parts state', async ({ page, electronApp, vaultDir }, testInfo) => {
  test.setTimeout(240_000);
  ensureOut();
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-9d-'));
  const git = (cwd: string, args: string[], date?: string): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: date === undefined ? process.env : { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(vaultDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, rel), text);
  };

  // -- the 9d desk
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(400);
  await arrangeDocks(page, {
    left: ['Calendar', 'Files', 'Source control', 'Outline', 'Search', 'Tasks', 'Backlinks', 'Tickets'],
    shown: ['Calendar', 'Files', 'Source control', 'Outline', 'Search', 'Tasks'],
    collapsed: ['Outline', 'Search', 'Tasks'],
    flexes: { 'Source control': 600, Files: 200 },
  });
  await page.reload();
  await sizeWindow(electronApp);
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDeskTabs(page);
  // Files is folded on the board; it had to be open to open the tabs.
  await page.locator('app-panel-frame', { has: page.locator('app-files-panel') }).locator('.head button[aria-expanded="true"]').first().click();
  await pushFleet(electronApp);
  await saveLayout(page);

  const panel = panelFrame(page, 'git-panel');
  const refresh = async (): Promise<void> => {
    await panel.locator('button[aria-label="More Git actions"]').click();
    await page.getByRole('menuitem', { name: 'Refresh the status' }).click();
  };

  // 9 · no repository yet: the vault is a plain folder
  await expect(panel.locator('.git-panel .git-empty')).toHaveText('This vault is not a Git repository.', { timeout: 20_000 });
  await page.mouse.move(700, 500);
  await page.waitForTimeout(400);
  await shootPanel(page, panel, 'DeskSourceControl.no-repo.png');

  // -- the repository: Weekly review pushed, one commit to pull, two not pushed
  const bare = path.join(remoteDir, 'notes.git');
  git(remoteDir, ['init', '--bare', '-b', 'main', bare]);
  git(vaultDir, ['init', '-b', 'main']);
  for (const [key, value] of [['user.name', 'dana'], ['user.email', 'dana@example.invalid'], ['core.autocrlf', 'false']]) {
    git(vaultDir, ['config', key, value]);
  }
  git(vaultDir, ['add', '-A']);
  git(vaultDir, ['commit', '-m', 'Weekly review'], at(3, 16, 0));
  // The tickets engine commits its own files (persona, ignore line) once the
  // vault is a repository; let it, and publish them with the first commit.
  for (let i = 0; i < 30 && !git(vaultDir, ['log', '--format=%s']).includes('tickets: you persona'); i++) {
    await page.waitForTimeout(500);
  }
  git(vaultDir, ['remote', 'add', 'origin', bare]);
  git(vaultDir, ['push', '-u', 'origin', 'main']);
  const clone = path.join(remoteDir, 'clone');
  git(remoteDir, ['clone', bare, clone]);
  git(clone, ['config', 'user.name', 'sam']);
  git(clone, ['config', 'user.email', 'sam@example.invalid']);
  fs.writeFileSync(path.join(clone, 'agenda.md'), '# Agenda\n');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-m', 'Agenda for Monday'], at(1, 9, 0));
  git(clone, ['push']);
  git(vaultDir, ['fetch']);
  write('projects/review-notes.md', '# Design review\n');
  git(vaultDir, ['add', '-A']);
  git(vaultDir, ['commit', '-m', 'Notes of the design review'], at(1, 17, 30));
  write('attachments/logo-square.png', 'png');
  git(vaultDir, ['add', '-A']);
  git(vaultDir, ['commit', '-m', 'Logo drafts for the relaunch', '-m', 'Adds the round and the square draft.'], at(0, 10, 42));
  // A second registered vault that is a repository: the board's repository button.
  git(path.join(testInfo.outputDir, 'vault-archive'), ['init', '-b', 'main']);
  // -- the five changes: one staged, four not
  write('projects/brand-guide.md', '# Brand guide\n\nColours, type and the logo.\n');
  git(vaultDir, ['add', 'projects/brand-guide.md']);
  write('projects/website-relaunch.md', '# Website relaunch\n\nThe plan, revised.\n');
  write('daily/2026-11-08.md', '# 2026-11-08\n');
  write('attachments/logo-round.drawio.svg', '<svg/>');
  fs.rmSync(path.join(vaultDir, 'projects', 'old-plan.md'));

  await refresh();
  await expect(panel.locator('.git-change')).toHaveCount(5, { timeout: 20_000 });
  await panel.locator('.git-history .fold').click();
  await expect(panel.locator('.git-log-row').nth(2)).toBeVisible();
  const settle = async (p: Page): Promise<void> => {
    await p.mouse.move(700, 500);
    await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await p.waitForTimeout(800);
  };
  // The board draws the header controls (the panel is the active one, req-163).
  await panel.locator('.git-panel').dispatchEvent('pointerdown');
  await page.mouse.move(700, 500);
  await page.waitForTimeout(800);
  const measured = await page.evaluate(() => {
    const box = (sel: string): string => {
      const el = document.querySelector(sel);
      if (el === null) {
        return 'absent';
      }
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    return {
      window: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
      head: box('.git-head'),
      compose: box('.git-compose'),
      group: box('.git-group'),
      row: box('.git-change'),
      log: box('.git-log-row'),
    };
  });
  console.log(JSON.stringify(measured));
  await page.screenshot({ path: path.join(OUT, 'DeskSourceControl.png') });
  await compareWithBoard(electronApp, 'DeskSourceControl');

  // 4 · hover: a group head, a row
  await panel.locator('.git-change', { hasText: 'website-relaunch.md' }).hover();
  await page.waitForTimeout(300);
  await shootPanel(page, panel, 'DeskSourceControl.hover-row.png');
  await panel.locator('.git-group', { hasText: /^Changes/ }).hover();
  await page.waitForTimeout(300);
  await shootPanel(page, panel, 'DeskSourceControl.hover-head.png');

  // 7 · More Git actions
  await panel.locator('button[aria-label="More Git actions"]').click();
  await page.waitForTimeout(300);
  await shootPanel(page, panel, 'DeskSourceControl.menu.png', 80);
  await page.keyboard.press('Escape');

  // 2 · amending
  await panel.locator('button[aria-label="More Git actions"]').click();
  await page.getByRole('menuitem', { name: 'Amend the last commit' }).click();
  await expect(panel.locator('.git-banner.git-amend')).toBeVisible();
  await panel.locator('.git-message').click();
  await page.waitForTimeout(300);
  await shootPanel(page, panel, 'DeskSourceControl.amend.png');
  await panel.locator('button[aria-label="Stop amending"]').click();
  await panel.locator('.git-message').fill('');
  await settle(page);

  // 10 · managed by a plugin (the status round main pushes, with the plugin's mark)
  const states = (await page.evaluate(() => window.dreyApi.invokePlugin('git', 'status', {}))) as Record<string, unknown>[];
  await pushPluginEvent(electronApp, 'git', 'status-updated', states.map((s) => ({ ...s, managedBy: 'Tickets' })));
  await expect(panel.locator('.git-banner.git-managed')).toBeVisible();
  await settle(page);
  await shootPanel(page, panel, 'DeskSourceControl.managed.png');
  await pushPluginEvent(electronApp, 'git', 'status-updated', states);
  await expect(panel.locator('.git-banner.git-managed')).toHaveCount(0);

  // 3 · busy: a push to a remote that never answers (an ssh command that only sleeps), with Cancel
  git(vaultDir, ['config', 'remote.origin.pushurl', 'ssh://slow.invalid/notes.git']);
  git(vaultDir, ['config', 'core.sshCommand', "sh -c 'sleep 60' --"]);
  await panel.locator('button[aria-label^="Push"]').click();
  await expect(panel.locator('.git-busy .git-link')).toBeVisible({ timeout: 10_000 });
  await settle(page);
  await shootPanel(page, panel, 'DeskSourceControl.busy.png');
  await panel.locator('.git-busy .git-link').evaluate((b) => (b as HTMLButtonElement).click());
  const dismiss = page.locator('.plugin-modal button', { hasText: /^(OK|Close)$/ });
  await expect(async () => {
    if ((await dismiss.count()) > 0) {
      await dismiss.first().click();
    }
    await expect(panel.locator('.git-busy')).toBeHidden({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  git(vaultDir, ['config', '--unset', 'remote.origin.pushurl']);
  git(vaultDir, ['config', '--unset', 'core.sshCommand']);

  // 1 · merging, two conflicts left
  git(vaultDir, ['stash', '-u']);
  git(vaultDir, ['checkout', '-b', 'relaunch']);
  write('projects/website-relaunch.md', '# Website relaunch\n\nRelaunch copy.\n');
  write('projects/brand-guide.md', '# Brand guide\n\nRelaunch colours.\n');
  git(vaultDir, ['commit', '-am', 'Relaunch copy']);
  git(vaultDir, ['checkout', 'main']);
  write('projects/website-relaunch.md', '# Website relaunch\n\nMain copy.\n');
  write('projects/brand-guide.md', '# Brand guide\n\nMain colours.\n');
  git(vaultDir, ['commit', '-am', 'Main copy']);
  try {
    git(vaultDir, ['merge', 'relaunch']);
  } catch {
    // the conflict is the point
  }
  write('attachments/logo-new.png', 'png');
  git(vaultDir, ['add', 'attachments/logo-new.png']);
  await refresh();
  await expect(panel.locator('.git-banner.git-merge')).toBeVisible({ timeout: 20_000 });
  await panel.locator('.git-change[data-status="conflict"]').first().hover();
  await page.waitForTimeout(300);
  await shootPanel(page, panel, 'DeskSourceControl.merge.png');
  git(vaultDir, ['merge', '--abort']);

  // 5 · the branch line: not published, detached
  git(vaultDir, ['checkout', 'relaunch']);
  await refresh();
  await expect(panel.locator('.git-head .sync')).toHaveText('Not published', { timeout: 20_000 });
  await settle(page);
  await shootPanel(page, panel, 'DeskSourceControl.not-published.png');
  git(vaultDir, ['checkout', '--detach', 'HEAD']);
  await refresh();
  await expect(panel.locator('.git-branch-btn .name')).toContainText('Detached at', { timeout: 20_000 });
  await settle(page);
  await shootPanel(page, panel, 'DeskSourceControl.detached.png');

  // 8 · clean
  git(vaultDir, ['checkout', 'main']);
  await refresh();
  await expect(panel.locator('.git-panel .git-empty.git-clean')).toBeVisible({ timeout: 20_000 });
  await settle(page);
  await shootPanel(page, panel, 'DeskSourceControl.clean.png');

  // 6 · folded by its chevron
  await panel.locator('.head button[aria-expanded="true"]').first().click();
  await settle(page);
  // Another surface active: the folded header shows no controls (req-163).
  await page.locator('app-editor .cm-content').first().click();
  await page.mouse.move(700, 500);
  await page.waitForTimeout(400);
  await shootPanel(page, panel, 'DeskSourceControl.folded.png');
});
