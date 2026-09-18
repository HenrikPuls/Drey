import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/**
 * Tab replacement (milestone 32): opening a file closes the focused clean
 * tab, so following files through the tree replaces the view instead of
 * accumulating tabs. A dirty focused tab stays and the new file opens
 * alongside.
 */

async function refresh(page: Page): Promise<void> {
  await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
}

test.describe('opening a file replaces the clean focused tab', () => {
  test('clicking through files keeps one tab', async ({ page, vaultDir }) => {
    fs.writeFileSync(path.join(vaultDir, 'a.md'), '# a\n\nbody a\n');
    fs.writeFileSync(path.join(vaultDir, 'b.md'), '# b\n\nbody b\n');
    await refresh(page);

    await page.locator('app-dock[side="left"] .node.file', { hasText: 'a.md' }).click();
    await expect(page.locator('app-tab-bar .tab', { hasText: 'a.md' })).toHaveCount(1);

    await page.locator('app-dock[side="left"] .node.file', { hasText: 'b.md' }).click();
    await expect(page.locator('app-tab-bar .tab', { hasText: 'b.md' })).toHaveCount(1);
    await expect(page.locator('app-tab-bar .tab', { hasText: 'a.md' })).toHaveCount(0);
    await expect(page.locator('app-editor .cm-content')).toContainText('body b');
  });

  test('a dirty focused tab stays; the new file opens alongside', async ({ page, vaultDir }) => {
    fs.writeFileSync(path.join(vaultDir, 'a.md'), '# a\n\nbody a\n');
    fs.writeFileSync(path.join(vaultDir, 'b.md'), '# b\n\nbody b\n');
    await refresh(page);

    await page.locator('app-dock[side="left"] .node.file', { hasText: 'a.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();
    await page.locator('app-editor .cm-content').click();
    await page.keyboard.type('typed');
    await expect(page.locator('app-tab-bar .tab .dirty')).toHaveCount(1);

    await page.locator('app-dock[side="left"] .node.file', { hasText: 'b.md' }).click();
    await expect(page.locator('app-tab-bar .tab', { hasText: 'b.md' })).toHaveCount(1);
    await expect(page.locator('app-tab-bar .tab', { hasText: 'a.md' })).toHaveCount(1);
    // b.md is focused now; a.md kept its unsaved buffer.
    await page.locator('app-tab-bar .tab', { hasText: 'a.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toContainText('typed');
  });
});
