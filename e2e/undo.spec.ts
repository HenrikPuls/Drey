import { test, expect } from './fixtures/drey';

/**
 * The editor's undo story (milestone 34): a FIRST load / tab switch puts
 * the document in a fresh CodeMirror state -- the load itself is not an
 * undo event. Previously the load was a dispatched full-range change
 * sitting at the bottom of the history, so a second Ctrl+Z in a freshly
 * opened tab rolled the LOAD back and wiped the document, and undoing
 * across a tab switch could resurrect the previous tab's content.
 *
 * In-place reloads of the SAME tab (save pipeline, watcher, live-edit
 * pushes) deliberately stay undoable dispatches -- those tests live with
 * the assistant's live-edit specs.
 */

const A = '# a\n\nbody a\n';
const B = '# b\n\nbody b\n';

test.use({ seedVault: { 'a.md': A, 'b.md': B } });

async function openFile(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).click();
  await expect(page.locator('app-editor .cm-content')).toContainText(`body ${name[0]}`);
}

test.describe('editor undo in a fresh tab', () => {
  test('undoing past the first edit stops at the load instead of wiping the document', async ({
    page,
  }) => {
    await openFile(page, 'a.md');

    // One real edit, then two undos: the first removes the edit, the
    // second must be a no-op (it used to remove the loaded document).
    // The click lands wherever the caret ends up — the assertions are
    // deliberately position-independent.
    await page.locator('app-editor .cm-content').click();
    await page.keyboard.type('typed ');
    await expect(page.locator('app-editor .cm-content')).toContainText('typed');

    await page.keyboard.press('Control+z');
    await expect(page.locator('app-editor .cm-content')).toContainText('body a');
    await expect(page.locator('app-editor .cm-content')).not.toContainText('typed');

    await page.keyboard.press('Control+z');
    // THE regression this spec guards: this undo used to roll the initial
    // LOAD back, leaving the tab empty.
    await expect(page.locator('app-editor .cm-content')).toContainText('body a');
  });

  test('undo does not bleed across a tab switch', async ({ page }) => {
    await openFile(page, 'a.md');
    await page.locator('app-editor .cm-content').click();
    await page.keyboard.type('typed ');
    // a.md is dirty now, so opening b.md opens alongside instead of
    // replacing the tab (milestone 32).
    await openFile(page, 'b.md');

    // Back to a.md: its buffer (with the unsaved edit) loads into a fresh
    // state — undo here is a no-op and must not resurrect b.md's content,
    // which the dispatched tab swaps used to allow.
    await page.locator('app-tab-bar .tab', { hasText: 'a.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toContainText('typed');
    await page.keyboard.press('Control+z');
    await expect(page.locator('app-editor .cm-content')).toContainText('typed');
    await expect(page.locator('app-editor .cm-content')).not.toContainText('body b');
  });
});
