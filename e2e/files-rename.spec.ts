import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';
import type { Locator } from '@playwright/test';

/**
 * The Files panel's inline name inputs (rename, new file / new folder, vault
 * rename) own every key while they are open -- only Enter, Escape and blur
 * leave them. Reproduction of the roadmap defect: `onTreeKeydown` is bound on
 * the tree container and had no guard for events from the input, so the
 * cursor keys moved the tree selection instead of the caret (its
 * `preventDefault` froze the caret), and Delete ran the tree's delete on the
 * selected *file* while the user was editing its *name*.
 */

test.use({ seedVault: { 'alpha.md': '# Alpha\n', 'beta.md': '# Beta\n' } });

/** Right-clicks a file row and opens its inline rename input. */
async function startRename(page: Page, fileName: string): Promise<Locator> {
  await page.locator('app-files-panel .node.file', { hasText: fileName }).click({ button: 'right' });
  await page.locator('.ctx-menu button', { hasText: 'Rename…' }).click();
  const input = page.locator('app-files-panel .node.editing input.create-input');
  await expect(input).toBeFocused();
  return input;
}

test.describe('Files panel inline rename input', () => {
  test('every key but Enter/Escape belongs to the open field', async ({ page, vaultDir }) => {
    // Select (and open) alpha.md first -- with the defect, Delete from the
    // name field ran the tree's delete on exactly this selected row.
    await page.locator('app-files-panel .node.file', { hasText: 'alpha.md' }).click();
    const input = await startRename(page, 'alpha.md');

    // The name stem arrives pre-selected; ArrowLeft collapses the caret.
    // (With the defect the tree's preventDefault ate the key and the stem
    // stayed selected.)
    await page.keyboard.press('ArrowLeft');
    expect(
      await input.evaluate((el) => el.selectionStart === el.selectionEnd),
    ).toBe(true);

    // Delete edits the name (caret at 0 removes the leading "a") -- it must
    // not delete a file: no confirm dialog, and with the defect the value
    // never changed.
    await page.keyboard.press('Delete');
    await expect(input).toHaveValue('lpha.md');
    await expect(page.locator('app-confirm-dialog .dialog')).toHaveCount(0);

    // ArrowDown belongs to the field too: focus must not follow a tree
    // selection move. The settle wait lets a wrongly scheduled focus-follow
    // fire before the assertion.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(60);
    await expect(input).toBeFocused();
    await expect(page.locator('app-confirm-dialog .dialog')).toHaveCount(0);

    // Escape cancels: the row is back and nothing happened on disk.
    await page.keyboard.press('Escape');
    await expect(page.locator('app-files-panel .node.file', { hasText: 'alpha.md' })).toBeVisible();
    expect(fs.existsSync(path.join(vaultDir, 'alpha.md'))).toBe(true);
  });

  test('Enter commits the typed name on disk; Escape leaves it untouched', async ({
    page,
    vaultDir,
  }) => {
    // The pre-selected stem makes a full retype one keystroke: typing
    // replaces "alpha", the extension stays.
    const input = await startRename(page, 'alpha.md');
    await page.keyboard.type('gamma');
    await expect(input).toHaveValue('gamma.md');
    await page.keyboard.press('Enter');

    await expect(page.locator('app-files-panel .node.file', { hasText: 'gamma.md' })).toBeVisible();
    await expect(page.locator('app-files-panel .node.file', { hasText: 'alpha.md' })).toHaveCount(0);
    expect(fs.existsSync(path.join(vaultDir, 'alpha.md'))).toBe(false);
    expect(fs.existsSync(path.join(vaultDir, 'gamma.md'))).toBe(true);

    // A cancelled rename changes nothing.
    const again = await startRename(page, 'gamma.md');
    await page.keyboard.type('zzz');
    await page.keyboard.press('Escape');
    await expect(page.locator('app-files-panel .node.file', { hasText: 'gamma.md' })).toBeVisible();
    expect(fs.existsSync(path.join(vaultDir, 'gamma.md'))).toBe(true);
  });

  test('the new-file input keeps its keys too (same guard)', async ({ page }) => {
    // "New file" from a root-level row's context menu lands its input row
    // under the vault header (the vault root's `dir` is '').
    await page.locator('app-files-panel .node.file', { hasText: 'alpha.md' }).click({
      button: 'right',
    });
    await page.locator('.ctx-menu button', { hasText: 'New file' }).click();
    const input = page.locator('app-files-panel .node.editing input.create-input');
    await expect(input).toBeFocused();

    await page.keyboard.type('note');
    // ArrowDown does nothing in a one-line field but jump to the line end;
    // ArrowLeft then walks the caret back and Delete removes the "e" --
    // none of that may reach the tree, and Delete must not delete any row.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Delete');
    await expect(input).toHaveValue('not');
    await expect(input).toBeFocused();
    await expect(page.locator('app-confirm-dialog .dialog')).toHaveCount(0);

    // Escape cancels the create: no row, nothing written.
    await page.keyboard.press('Escape');
    await expect(page.locator('app-files-panel .node.editing')).toHaveCount(0);
  });
});
