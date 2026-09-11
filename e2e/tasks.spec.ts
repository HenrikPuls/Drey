import { test, expect, type Page } from './fixtures/drey';

/**
 * The Tasks plugin (ADR-0044 stage 6): the Tasks dock panel's document /
 * whole-vault scopes, the row checkbox writing back into the note, the
 * kind filter, and the persisted scope preference. (`Mod+Enter` is covered
 * by the pane/editor specs' keymap expectations; the scanner and filter
 * logic has unit specs.)
 *
 * The notes are seeded before launch (`seedVault`): the whole-vault index
 * is built at plugin activation, and — no file watcher (ADR-0018) — files
 * added later from outside reach it only via the next save/rename/delete.
 */

const NOTE = [
  '---',
  'title: Tasks demo',
  '---',
  '',
  '## Projekt Alpha #project',
  '',
  '- [ ] draft the brief',
  '- [x] send the invoice',
  '',
  '## Wohnen',
  '',
  'Fix the roof #task',
  '',
].join('\n');

const OTHER = ['---', 'title: Other', '---', '', '- [ ] water the plants', ''].join('\n');

test.use({ seedVault: { 'tasks-demo.md': NOTE, 'other.md': OTHER } });

async function openTasksPanel(page: Page): Promise<void> {
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'tasks-demo.md' }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
  // The plugin's panel: collapsed by default, its header press expands it.
  await page.locator('app-panel-frame .head[aria-label="Expand Tasks"]').click();
  await expect(page.locator('app-panel-frame .tasks-panel')).toBeVisible();
}

test.describe('Tasks plugin panel', () => {
  test('document scope lists the live buffer and ticking a row rewrites the note', async ({
    page,
  }) => {
    await openTasksPanel(page);

    const panel = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    const rows = panel.locator('.task');
    await expect(rows).toHaveCount(3);
    await expect(rows.locator('.text')).toHaveText([
      'draft the brief',
      'send the invoice',
      'Fix the roof',
    ]);
    await expect(panel.locator('.head .status')).toHaveText('2 open');
    // The `#task` line carries its kind chip (kind filter default: both on).
    await expect(rows.filter({ hasText: 'Fix the roof' }).locator('.kind')).toHaveText('#task');

    // Tick the first row's checkbox: the open buffer gains the `x` and saves.
    // (Live Preview renders the box as a widget -- the done-task text gets
    // the `lp-task-done` decoration, same hook menu-and-dock.spec asserts.)
    await rows.filter({ hasText: 'draft the brief' }).locator('.box').click();
    await expect(
      page.locator('app-editor .cm-content .lp-task-done', { hasText: 'draft the brief' }),
    ).toHaveCount(1);
    await expect(panel.locator('.head .status')).toHaveText('1 open');
    // The row follows the buffer (document scope scans the live editor).
    await expect(rows.filter({ hasText: 'draft the brief' })).toHaveClass(/done/);
  });

  test('the kind filter and the free-text filter narrow the document list', async ({ page }) => {
    await openTasksPanel(page);

    const panel = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    const rows = panel.locator('.task');
    await expect(rows).toHaveCount(3);

    // `#` toggles the #task kind off: only the checkboxes remain.
    await panel.locator('.tasks-hdr .tgl[aria-label="Show lines tagged #task"]').click();
    await expect(rows).toHaveCount(2);

    // Free text narrows further, and the Clear filter row appears.
    await panel.locator('.text-input').fill('invoice');
    await expect(rows).toHaveCount(1);
    await expect(rows.filter({ hasText: 'send the invoice' })).toHaveCount(1);
    await panel.locator('.clear').click();
    await expect(rows).toHaveCount(2);
  });

  test('vault scope groups by file and the scope choice persists across a reload', async ({
    page,
  }) => {
    await openTasksPanel(page);

    const panel = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    await panel.locator('.tasks-hdr .seg button', { hasText: 'Vault' }).click();

    // Grouped by file, full paths as headers, 1-based line locations.
    const groups = panel.locator('.group');
    await expect(groups).toHaveCount(2);
    await expect(groups.filter({ hasText: 'tasks-demo.md' })).toHaveCount(1);
    await expect(groups.filter({ hasText: 'other.md' })).toHaveCount(1);
    await expect(
      panel.locator('.task', { hasText: 'Fix the roof' }).locator('.loc'),
    ).toHaveText(':12');

    // The scope survives a reload (localStorage['drey.tasks'], same key and
    // shape the pre-conversion panel used).
    await page.reload();
    const reloaded = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    await expect(
      reloaded.locator('.tasks-hdr .seg button.on', { hasText: 'Vault' }),
    ).toHaveCount(1);
    await expect(reloaded.locator('.group', { hasText: 'tasks-demo.md' })).toHaveCount(1);
  });
});
