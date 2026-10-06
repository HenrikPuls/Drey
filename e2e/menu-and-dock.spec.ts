import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * Regressions for three post-milestone-15 findings:
 *  1. the titlebar Edit/Selection menu stole focus, so "Select all" (and
 *     Cut/Copy/Paste) acted on the whole page, not the focused editor;
 *  2. the native right-click menu — that its context-menu params stay
 *     sound, and that an open titlebar menu no longer swallows a
 *     right-click via its overlay;
 */

async function openANote(page: import('@playwright/test').Page, vaultDir: string): Promise<void> {
  fs.writeFileSync(path.join(vaultDir, 'diag.md'), 'alpha beta gamma\nsecond line\nthird line\n');
  await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'diag.md' }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
}

test.describe('finding 1 — Select all target', () => {
  test('titlebar "Select all" selects only the focused editor, not the page', async ({
    page,
    vaultDir,
  }) => {
    await openANote(page, vaultDir);
    await page.locator('app-editor .cm-content').click();

    // Open Selection → Select all from the HTML titlebar menu.
    await page.locator('app-titlebar .menu-label', { hasText: 'Selection' }).click();
    await page.locator('app-titlebar .popover .row', { hasText: 'Select all' }).click();

    // The selection should be the editor's whole document and nothing from
    // the app chrome (titlebar / status bar / dock).
    const domSelText = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(domSelText).toContain('alpha beta gamma');
    expect(domSelText).toContain('third line');
    expect(domSelText.toLowerCase()).not.toContain('drey'); // titlebar brand
    expect(domSelText.toLowerCase()).not.toContain('chars'); // status bar
  });
});

test.describe('finding 2 — native context menu params', () => {
  test('right-click in the editor opens the renderer-owned context menu (ADR-0030)', async ({
    page,
    electronApp,
    vaultDir,
  }) => {
    await openANote(page, vaultDir);
    await page.locator('app-editor .cm-content').click();

    // Since ADR-0030 the editor's context menu is renderer-owned: the
    // capture-phase service preventDefaults the DOM gesture (which also
    // means Electron's native webContents 'context-menu' event never fires
    // over CodeMirror — the old native-params assertion here could no
    // longer pass). Assert the custom menu with its clipboard rows.
    const nativeFired = electronApp.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      return new Promise<boolean>((resolve) => {
        wc.once('context-menu', () => resolve(true));
        setTimeout(() => resolve(false), 2000);
      });
    });
    await page.locator('app-editor .cm-content').click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible();
    await expect(page.locator('.ctx-menu button', { hasText: 'Paste' })).toBeVisible();
    expect(await nativeFired).toBe(false);
  });

  test('an open titlebar menu is dismissed by a right-click (overlay no longer swallows it)', async ({
    page,
    vaultDir,
  }) => {
    await openANote(page, vaultDir);
    await page.locator('app-titlebar .menu-label', { hasText: 'Edit' }).click();
    await expect(page.locator('app-titlebar .popover')).toBeVisible();

    // A right-click over the editor area lands on the full-viewport overlay
    // while the menu is open; it must dismiss the menu (not swallow the
    // click silently).
    await page.locator('app-titlebar .overlay').click({ button: 'right', force: true });
    await expect(page.locator('app-titlebar .popover')).toHaveCount(0);
    await expect(page.locator('app-titlebar .overlay')).toHaveCount(0);
  });
});

test.describe('Edit menu — history / clipboard act on the focused editor', () => {
  async function editMenu(page: import('@playwright/test').Page, row: string): Promise<void> {
    await page.locator('app-titlebar .menu-label', { hasText: 'Edit' }).click();
    await page.locator('app-titlebar .popover .row', { hasText: row }).click();
  }

  test('Undo / Redo from the Edit menu reach CodeMirror history', async ({ page, vaultDir }) => {
    await openANote(page, vaultDir);
    const editor = page.locator('app-editor .cm-content');
    await editor.click();
    await page.keyboard.type('EXTRAWORD');
    await expect(editor).toContainText('EXTRAWORD');

    await editMenu(page, 'Undo');
    await expect(editor).not.toContainText('EXTRAWORD');

    await editMenu(page, 'Redo');
    await expect(editor).toContainText('EXTRAWORD');
  });

  test('Copy from the Edit menu puts the selection on the clipboard', async ({
    page,
    electronApp,
    vaultDir,
  }) => {
    await openANote(page, vaultDir);
    const editor = page.locator('app-editor .cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+A');

    await electronApp.evaluate(({ clipboard }) => clipboard.writeText('SENTINEL'));
    await editMenu(page, 'Copy');

    await expect
      .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('alpha beta gamma');
  });
});

test.describe('View menu — widget visibility (ADR-0034)', () => {
  test('deselecting "Open windows" removes the whole panel; reselecting brings it back', async ({
    page,
  }) => {
    const frame = page.locator('app-panel-frame', {
      has: page.locator('.head[aria-label$="Open windows"]'),
    });
    await expect(frame).toHaveCount(1);

    await page.locator('app-titlebar .menu-label', { hasText: 'View' }).click();
    await page.locator('app-titlebar .popover .row', { hasText: 'Open windows' }).click();
    await expect(frame).toHaveCount(0);

    await page.locator('app-titlebar .menu-label', { hasText: 'View' }).click();
    await page.locator('app-titlebar .popover .row', { hasText: 'Open windows' }).click();
    await expect(frame).toHaveCount(1);
  });

  test('the "Add entry" panel is gone: no View row, no bottom dock by default', async ({ page }) => {
    await page.locator('app-titlebar .menu-label', { hasText: 'View' }).click();
    await expect(page.locator('app-titlebar .popover .row', { hasText: 'Add entry' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('app-dock[side="bottom"] app-panel-frame')).toHaveCount(0);
  });
});

test.describe('Live Preview — checked tasks', () => {
  test('a "- [x]" line is struck through, an open one is not', async ({ page, vaultDir }) => {
    fs.writeFileSync(
      path.join(vaultDir, 'todos.md'),
      '# Todos\n\n- [ ] open task\n- [x] done task\n',
    );
    await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'todos.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();

    const done = page.locator('app-editor .cm-content .lp-task-done');
    await expect(done).toHaveText(/done task/);
    await expect(done).toHaveCSS('text-decoration-line', 'line-through');

    const openLine = page.locator('app-editor .cm-line', { hasText: 'open task' });
    await expect(openLine.locator('.lp-task-done')).toHaveCount(0);
  });
});
