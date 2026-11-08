import * as path from 'node:path';
import { test, expect } from './fixtures/drey';
import {
  DESK_CONFIG,
  DESK_SEED,
  OUT,
  arrangeDocks,
  compareWithBoard,
  ensureOut,
  openDeskTabs,
  openInNewTab,
  panelFrame,
  pushFleet,
  saveLayout,
  shootPanel,
  sizeWindow,
} from './fixtures/fidelity-desk';

/**
 * NOT a regression suite: puts the built app in the states boards 9e
 * `DeskOutline` and `DeskOutlineParts` show (req-162) and takes the
 * screenshots the fidelity checklist asks for. Opt-in:
 *
 *   . .\env.ps1
 *   $env:DREY_FIDELITY_SHOTS = '1'
 *   npm run e2e:run -- fidelity-desk-outline
 *
 * Output under `test-results/fidelity/`: `DeskOutline.png` (1440x900,
 * scale factor 1, + compare.html captures) and one crop of the panel per
 * Parts state (`DeskOutline.<state>.png`).
 */

const RUN = !!process.env['DREY_FIDELITY_SHOTS'];
test.skip(!RUN, 'set DREY_FIDELITY_SHOTS=1 -- the board 9e screenshots');

const RELAUNCH = [
  '# Website relaunch',
  '',
  '## Brand',
  '',
  '### Logo',
  '',
  'Round and square drafts.',
  '',
  '### Colours',
  '',
  'Warm greys with one blue.',
  '',
  '## Next steps',
  '',
  '### Copy',
  '',
  '### Photos',
  '',
  '## Shoot',
  '',
  '## Budget and the people who sign it off',
  '',
  '# Open questions',
  '',
  '## Hosting',
  '',
].join('\n');

const seed: Record<string, string> = {
  ...DESK_SEED,
  'website-relaunch.md': RELAUNCH,
  'scratch.md': 'A line without any heading.\n',
};

test.use({ seedVault: seed, launchArgs: ['--force-device-scale-factor=1'], appConfig: DESK_CONFIG });

test('board 9e: Outline in the Work view, then every Parts state', async ({ page, electronApp }) => {
  test.setTimeout(180_000);
  ensureOut();
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(400);
  await arrangeDocks(page, {
    left: ['Calendar', 'Files', 'Outline', 'Source control', 'Search', 'Tasks', 'Backlinks', 'Tickets'],
    shown: ['Calendar', 'Files', 'Outline', 'Source control', 'Search', 'Tasks'],
    collapsed: ['Source control', 'Search', 'Tasks'],
    flexes: { Files: 330, Outline: 215 },
  });
  await page.reload();
  await sizeWindow(electronApp);
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDeskTabs(page);
  await pushFleet(electronApp);
  await saveLayout(page);

  const panel = panelFrame(page, 'outline-panel');
  await expect(panel.locator('.row')).toHaveCount(5, { timeout: 20_000 });
  // The caret in the Description section (board 9e), the panel active (req-163).
  await page.locator('app-editor .cm-line', { hasText: 'Behaviour-neutral slicing' }).first().click();
  await panel.locator('.outline-panel').dispatchEvent('pointerdown');
  await page.mouse.move(700, 500);
  await page.waitForTimeout(800);
  await expect(panel.locator('.row.current')).toHaveText('Description');
  await page.screenshot({ path: path.join(OUT, 'DeskOutline.png') });
  await compareWithBoard(electronApp, 'DeskOutline');

  // 1 · three levels, one folded, the caret's heading marked
  await openInNewTab(page, 'website-relaunch.md');
  await openInNewTab(page, 'scratch.md');
  await page.locator('app-tab-bar .tab', { hasText: 'website-relaunch' }).click();
  // The Parts crops show the whole tree: Files folds to its header.
  await page.locator('app-panel-frame', { has: page.locator('app-files-panel') }).locator('.head button[aria-expanded="true"]').first().click();
  await expect(panel.locator('.row', { hasText: 'Next steps' })).toBeVisible();
  await panel.locator('.row', { hasText: 'Next steps' }).locator('.twist').click();
  await page.locator('app-editor .cm-line', { hasText: 'Warm greys' }).first().click();
  await panel.locator('.head').hover();
  await page.waitForTimeout(500);
  await expect(panel.locator('.row.current')).toHaveText('Colours');
  await shootPanel(page, panel, 'DeskOutline.levels.png');

  // 2 · all levels collapsed
  await panel.locator('button[aria-label="Collapse all levels"]').click();
  await page.waitForTimeout(300);
  await shootPanel(page, panel, 'DeskOutline.collapsed.png');
  console.log(
    'pressed switch:',
    await panel.locator('button[aria-label="Expand all levels"]').evaluate((b) => getComputedStyle(b).backgroundColor),
  );
  await panel.locator('button[aria-label="Expand all levels"]').click();

  // 4 · empty states
  await page.locator('app-tab-bar .tab', { hasText: 'scratch' }).click();
  await page.mouse.move(700, 500);
  await page.waitForTimeout(400);
  await expect(panel.locator('.empty')).toHaveText('No headings in this document.');
  await shootPanel(page, panel, 'DeskOutline.no-headings.png');
  // The Settings tab is no note.
  await page.keyboard.press('Control+,');
  await expect(panel.locator('.empty')).toHaveText('Open a note to see its outline.', { timeout: 10_000 });
  await page.mouse.move(700, 500);
  await page.waitForTimeout(300);
  await shootPanel(page, panel, 'DeskOutline.no-note.png');

  // 3 · folded by its chevron
  await panel.locator('.head button[aria-expanded="true"]').first().click();
  await page.waitForTimeout(300);
  // Another surface active: the folded header shows no controls (req-163).
  await page.locator('app-tab-bar .tab', { hasText: 'scratch' }).click();
  await page.mouse.move(700, 500);
  await page.waitForTimeout(400);
  await shootPanel(page, panel, 'DeskOutline.folded.png');
});
