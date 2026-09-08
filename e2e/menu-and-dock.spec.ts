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
 *  3. the bottom-dock resize divider stayed visible while "Add entry"
 *     (its only panel) was collapsed.
 */

async function openANote(page: import('@playwright/test').Page, vaultDir: string): Promise<void> {
  fs.writeFileSync(path.join(vaultDir, 'diag.md'), 'alpha beta gamma\nsecond line\nthird line\n');
  await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
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
  test('right-click in the editor reports an editable target with paste enabled', async ({
    page,
    electronApp,
    vaultDir,
  }) => {
    await openANote(page, vaultDir);
    await page.locator('app-editor .cm-content').click();

    const paramsPromise = electronApp.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      return new Promise<{ isEditable: boolean; canPaste: boolean; canCopy: boolean }>(
        (resolve) => {
          wc.once('context-menu', (_e, p) => {
            resolve({
              isEditable: p.isEditable,
              canPaste: p.editFlags.canPaste,
              canCopy: p.editFlags.canCopy,
            });
          });
        },
      );
    });
    await page.locator('app-editor .cm-content').click({ button: 'right' });
    const params = await paramsPromise;
    console.log('context-menu params:', JSON.stringify(params));
    expect(params.isEditable).toBe(true);
    expect(params.canPaste).toBe(true);
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

test.describe('bottom dock — "Add entry" panel', () => {
  test('collapsing "Add entry" removes the bottom-dock resize divider', async ({ page }) => {
    const bottom = page.locator('app-dock[side="bottom"]');
    const head = bottom.locator('app-panel-frame .head').first();
    const divider = page.locator('.center-col .divider-y[aria-label="Resize bottom dock"]');

    // Default: "Add entry" starts collapsed → no divider.
    await expect(divider).toHaveCount(0);

    // Expand it → divider appears and the band takes bottomH (poll past the
    // ~140ms collapse/expand height animation).
    await head.click();
    await expect(divider).toHaveCount(1);
    await expect
      .poll(() => bottom.evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThan(120);

    // Collapse again → divider gone, band is just the header.
    await head.click();
    await expect(divider).toHaveCount(0);
    await expect
      .poll(() => bottom.evaluate((el) => el.getBoundingClientRect().height))
      .toBeLessThan(80);
  });

  test('the "Add entry" text field grows to fill the expanded panel', async ({ page }) => {
    const bottom = page.locator('app-dock[side="bottom"]');
    await bottom.locator('app-panel-frame .head').first().click();

    const field = bottom.locator('app-entry-drawer .md-editor');
    const short = await field.evaluate((el) => el.getBoundingClientRect().height);

    // Drag the bottom-dock divider up ~150px to enlarge the band.
    const divider = page.locator('.center-col .divider-y[aria-label="Resize bottom dock"]');
    const box = await divider.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y - 150, { steps: 8 });
    await page.mouse.up();

    const tall = await field.evaluate((el) => el.getBoundingClientRect().height);
    expect(tall).toBeGreaterThan(short + 100);
  });
});

test.describe('Live Preview — checked tasks', () => {
  test('a "- [x]" line is struck through, an open one is not', async ({ page, vaultDir }) => {
    fs.writeFileSync(
      path.join(vaultDir, 'todos.md'),
      '# Todos\n\n- [ ] open task\n- [x] done task\n',
    );
    await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'todos.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();

    const done = page.locator('app-editor .cm-content .lp-task-done');
    await expect(done).toHaveText(/done task/);
    await expect(done).toHaveCSS('text-decoration-line', 'line-through');

    const openLine = page.locator('app-editor .cm-line', { hasText: 'open task' });
    await expect(openLine.locator('.lp-task-done')).toHaveCount(0);
  });
});
