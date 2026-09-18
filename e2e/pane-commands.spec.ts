import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * The split-view keyboard / menu entry points (milestone 19a). The pane
 * mechanics themselves (PaneService, PaneLayout) are unit-tested; this
 * checks that the app-wide commands and the View-menu rows reach them.
 */
test.describe('split-view entry points', () => {
  test('Ctrl+Alt+Enter splits the editor into two panes', async ({ page, vaultDir }) => {
    fs.writeFileSync(path.join(vaultDir, 'one.md'), '# one\n\nbody\n');
    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'one.md' }).click();
    await expect(page.locator('app-editor')).toHaveCount(1);

    await page.locator('app-editor .cm-content').click();
    await page.keyboard.press('Control+Alt+Enter');

    // Tab replacement (milestone 32): opening one.md already replaced the
    // clean startup daily tab, so the pane held a single tab -- the split
    // moves it into the new pane and empties the source pane.
    await expect(page.locator('app-pane-leaf')).toHaveCount(2);
    await expect(page.locator('app-tab-bar .tab', { hasText: 'one.md' })).toHaveCount(1);
    await expect(page.locator('app-pane-leaf .empty')).toHaveCount(1);
  });

  test('the View menu exposes the split rows', async ({ page, vaultDir }) => {
    fs.writeFileSync(path.join(vaultDir, 'two.md'), '# two\n');
    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'two.md' }).click();
    await expect(page.locator('app-editor')).toHaveCount(1);

    await page.locator('app-titlebar .menu-label', { hasText: 'View' }).click();
    const menu = page.locator('app-titlebar .popover');
    await expect(menu.locator('.row', { hasText: 'Split editor right' })).toBeVisible();
    await expect(menu.locator('.row', { hasText: 'Split editor down' })).toBeVisible();

    await menu.locator('.row', { hasText: 'Split editor right' }).click();
    // Same post-condition as the chord: two panes, the single tab moved.
    await expect(page.locator('app-pane-leaf')).toHaveCount(2);
    await expect(page.locator('app-tab-bar .tab', { hasText: 'two.md' })).toHaveCount(1);
    await expect(page.locator('app-pane-leaf .empty')).toHaveCount(1);
  });
});
