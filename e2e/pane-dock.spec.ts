import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Locator, type Page } from './fixtures/drey';

/**
 * Editor panes in the docks (milestone 20, ADR-0038): the tab context menu
 * moves a pane into a dock's editor band, the band header drags it between
 * docks and back to the centre, a dock can only host one band (the
 * occupant is displaced back to the centre), splits refuse on docked
 * panes, the band has its own splitter, and View -> Reset layout undocks.
 *
 * Restart restore of docked editors is covered by PaneService unit tests
 * (the suite has no app-relaunch precedent); everything here runs in one
 * launch. The startup daily-note draft shares the centre pane with the
 * tabs these tests open, so assertions are count-based on a.md/b.md
 * behaviour, never on the full tab list.
 */

async function open(page: Page, vaultDir: string, name: string): Promise<void> {
  fs.writeFileSync(path.join(vaultDir, name), `# ${name}\n\nbody of ${name}\n`);
  await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).click();
}

/**
 * Opens two files side by side. Sequential clicks keep only the last file
 * any more -- `openFile` replaces the focused clean tab (milestone 32) --
 * so both rows are selected (Ctrl+click) and opened in one Enter:
 * `openSelection` replaces only on its first call, so both tabs survive.
 */
async function openTwo(page: Page, vaultDir: string, first: string, second: string): Promise<void> {
  await open(page, vaultDir, first); // replaces the startup daily tab
  fs.writeFileSync(path.join(vaultDir, second), `# ${second}\n\nbody of ${second}\n`);
  await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
  await page
    .locator('app-dock[side="left"] .node.file', { hasText: second })
    .click({ modifiers: ['ControlOrMeta'] });
  await page.keyboard.press('Enter');
  await expect(tab(page, first)).toHaveCount(1);
  await expect(tab(page, second)).toHaveCount(1);
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('locator has no bounding box');
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const tab = (page: Page, name: string): Locator =>
  page.locator('app-tab-bar .tab', { hasText: name });

/** Moves the pane holding `name`'s tab into `side`'s editor band via the tab context menu. */
async function moveToDock(page: Page, name: string, side: 'left' | 'right' | 'bottom'): Promise<void> {
  await tab(page, name).click({ button: 'right' });
  await page
    .locator('.ctx-menu button', { hasText: `Move to ${side} dock` })
    .click();
}

const band = (page: Page, side: 'left' | 'right' | 'bottom'): Locator =>
  page.locator(`app-dock[side="${side}"] .editor-band`);

test.describe('editor panes in the docks', () => {
  test('the tab context menu moves a pane into the right dock', async ({ page, vaultDir }) => {
    await open(page, vaultDir, 'a.md');
    await moveToDock(page, 'a.md', 'right');

    await expect(band(page, 'right')).toHaveCount(1);
    await expect(page.locator('app-dock[side="right"] app-editor')).toHaveCount(1);
    // The centre column keeps only the fresh placeholder pane.
    await expect(page.locator('.main-pane app-editor')).toHaveCount(0);
    await expect(tab(page, 'a.md')).toHaveCount(1); // same tab strip, new home
  });

  test('dragging the band header back to the centre restores the editor there', async ({
    page,
    vaultDir,
  }) => {
    await open(page, vaultDir, 'a.md');
    await moveToDock(page, 'a.md', 'right');

    const from = await centre(band(page, 'right').locator('.head'));
    const mainPane = await centre(page.locator('.main-pane'));

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(mainPane.x, mainPane.y, { steps: 10 });
    // Mid-drag: the centre shows its drop wash.
    await expect(page.locator('.main-pane.editor-drop')).toHaveCount(1);
    await page.mouse.up();

    await expect(band(page, 'right')).toHaveCount(0);
    await expect(page.locator('.main-pane app-editor')).toHaveCount(1);
    await expect(page.locator('.main-pane.editor-drop')).toHaveCount(0);
  });

  test('dragging the band header to another dock moves it there', async ({ page, vaultDir }) => {
    await open(page, vaultDir, 'a.md');
    await moveToDock(page, 'a.md', 'right');

    const from = await centre(band(page, 'right').locator('.head'));
    const left = await centre(page.locator('app-dock[side="left"]'));

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(left.x, left.y, { steps: 10 });
    await page.mouse.up();

    await expect(band(page, 'right')).toHaveCount(0);
    await expect(band(page, 'left')).toHaveCount(1);
    await expect(page.locator('app-dock[side="left"] app-editor')).toHaveCount(1);
  });

  test('dragging the last tab out of a band dissolves the band', async ({ page, vaultDir }) => {
    // Close the startup daily-note draft so the pane under test can hold
    // exactly one tab.
    await page.locator('app-tab-bar .tab[title*="daily"] .close').click();
    await open(page, vaultDir, 'a.md');
    await moveToDock(page, 'a.md', 'right');
    // Focus the centre placeholder, so the next open lands there.
    await page.locator('.main-pane app-pane-leaf').click();
    await open(page, vaultDir, 'b.md');

    const from = await centre(tab(page, 'a.md'));
    const body = await centre(page.locator('.main-pane app-editor .cm-content'));

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(body.x, body.y, { steps: 10 });
    await page.mouse.up();

    await expect(band(page, 'right')).toHaveCount(0);
    await expect(page.locator('.main-pane app-editor')).toHaveCount(1);
  });

  test('a dock hosts one editor: docking a second pane displaces the first back to the centre', async ({
    page,
    vaultDir,
  }) => {
    await openTwo(page, vaultDir, 'a.md', 'b.md');
    await page.locator('.main-pane app-editor .cm-content').first().click();
    await page.keyboard.press('Control+Alt+Enter'); // split right: b.md into pane 2
    await expect(page.locator('.main-pane app-editor')).toHaveCount(2);

    await moveToDock(page, 'a.md', 'right');
    await expect(band(page, 'right')).toHaveCount(1);
    await moveToDock(page, 'b.md', 'right'); // occupied -- pane 1 returns to the centre

    await expect(page.locator('app-dock[side="right"] app-editor')).toHaveCount(1);
    await expect(page.locator('.main-pane app-editor')).toHaveCount(1);
    await expect(tab(page, 'a.md')).toHaveCount(1);
    await expect(tab(page, 'b.md')).toHaveCount(1);
  });

  test('split commands refuse while the focused pane is docked', async ({ page, vaultDir }) => {
    await open(page, vaultDir, 'a.md');
    await moveToDock(page, 'a.md', 'right');
    await page.locator('app-dock[side="right"] app-editor .cm-content').click();

    await page.keyboard.press('Control+Alt+Enter');

    await expect(page.locator('app-editor')).toHaveCount(1);
    await expect(band(page, 'right')).toHaveCount(1);
  });

  test('the band splitter resizes the band against the widgets below', async ({
    page,
    vaultDir,
  }) => {
    await open(page, vaultDir, 'a.md');
    await moveToDock(page, 'a.md', 'right'); // the right dock's Assistant sits below the band

    const before = (await band(page, 'right').boundingBox())?.height ?? 0;
    const splitter = page.locator('app-dock[side="right"] > .split').first();
    const from = await centre(splitter);

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x, from.y - 60, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => (await band(page, 'right').boundingBox())?.height ?? 0)
      .toBeGreaterThan(before + 30);
  });

  test('View -> Reset layout brings docked editors back to the centre', async ({
    page,
    vaultDir,
  }) => {
    await open(page, vaultDir, 'a.md');
    await moveToDock(page, 'a.md', 'right');
    await expect(band(page, 'right')).toHaveCount(1);

    await page.locator('app-titlebar .menu-label', { hasText: 'View' }).click();
    await page.locator('app-titlebar .popover .row', { hasText: 'Reset layout' }).click();

    await expect(band(page, 'right')).toHaveCount(0);
    await expect(band(page, 'left')).toHaveCount(0);
    await expect(page.locator('.main-pane app-editor')).toHaveCount(1);
  });
});
