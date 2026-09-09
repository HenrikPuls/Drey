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
    await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'one.md' }).click();
    await expect(page.locator('app-editor')).toHaveCount(1);

    await page.locator('app-editor .cm-content').click();
    await page.keyboard.press('Control+Alt+Enter');

    await expect(page.locator('app-editor')).toHaveCount(2);
    // The split moved the active tab into the new pane; both panes show a tab.
    await expect(page.locator('app-tab-bar .tab', { hasText: 'one.md' })).toHaveCount(1);
  });

  test('the View menu exposes the split rows', async ({ page, vaultDir }) => {
    fs.writeFileSync(path.join(vaultDir, 'two.md'), '# two\n');
    await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'two.md' }).click();
    await expect(page.locator('app-editor')).toHaveCount(1);

    await page.locator('app-titlebar .menu-label', { hasText: 'View' }).click();
    const menu = page.locator('app-titlebar .popover');
    await expect(menu.locator('.row', { hasText: 'Split editor right' })).toBeVisible();
    await expect(menu.locator('.row', { hasText: 'Split editor down' })).toBeVisible();

    await menu.locator('.row', { hasText: 'Split editor right' }).click();
    await expect(page.locator('app-editor')).toHaveCount(2);
  });
});
