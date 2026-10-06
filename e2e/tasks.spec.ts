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
  // The content-height Calendar would leave the expanded panel's first rows
  // under its scroll clip at short windows (a ~48px body scrolls, but the
  // row's click point still sits past the clip edge) -- collapse it first so
  // the panel gets room at any window height.
  await page.locator('app-panel-frame .head[aria-label="Collapse Calendar"]').click();
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

  test('vault scope: ticking rows back-to-back keeps every row done (regression)', async ({
    page,
  }) => {
    await openTasksPanel(page);

    const panel = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    await panel.locator('.tasks-hdr .seg button', { hasText: 'Vault' }).click();
    const rows = panel.locator('.task');
    await expect(rows).toHaveCount(4); // 3 in tasks-demo.md (1 done) + 1 in other.md

    // Tick the three open ones back-to-back, without waiting for the list
    // between clicks -- the old silent save drop lost every tick that
    // landed while the previous save was still running, and the next list
    // pull "reset" the rows to open.
    await rows.filter({ hasText: 'draft the brief' }).locator('.box').click();
    await rows.filter({ hasText: 'Fix the roof' }).locator('.box').click();
    await rows.filter({ hasText: 'water the plants' }).locator('.box').click();

    await expect(rows.filter({ hasText: 'draft the brief' })).toHaveClass(/done/);
    await expect(rows.filter({ hasText: 'Fix the roof' })).toHaveClass(/done/);
    await expect(rows.filter({ hasText: 'water the plants' })).toHaveClass(/done/);

    // And they reached DISK, not just the open buffers: after a reload the
    // rebuilt index still reports every row done.
    await page.reload();
    const reloaded = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    const reloadedRows = reloaded.locator('.task');
    await expect(reloadedRows.filter({ hasText: 'draft the brief' })).toHaveClass(/done/);
    await expect(reloadedRows.filter({ hasText: 'Fix the roof' })).toHaveClass(/done/);
    await expect(reloadedRows.filter({ hasText: 'water the plants' })).toHaveClass(/done/);
    await expect(reloadedRows).toHaveCount(4); // the pre-done one still lists too
  });

  test('clicking the checkbox in the editor reaches the vault list and disk', async ({ page }) => {
    await openTasksPanel(page);

    const panel = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    await panel.locator('.tasks-hdr .seg button', { hasText: 'Vault' }).click();
    const rows = panel.locator('.task');
    await expect(rows.filter({ hasText: 'draft the brief' })).toHaveCount(1);

    // Click the rendered checkbox in Live Preview -- no Ctrl+S anywhere.
    // (This used to only dirty the buffer: the vault list, a disk index,
    // never adopted it until an unrelated save.) The checkbox widget sits
    // in the task's line; the line's text lives next to it.
    // The click gesture can be swallowed by an in-flight decoration
    // rebuild right after the tab opens (a CM widget swap between the hit
    // test and the mousedown) -- retry click and effect as ONE unit; the
    // first effective click wins.
    await expect(async () => {
      await page
        .locator('app-editor .cm-content .cm-line', { hasText: 'draft the brief' })
        .locator('.lp-task input')
        .click();
      await expect(
        page.locator('app-editor .cm-content .lp-task-done', { hasText: 'draft the brief' }),
      ).toHaveCount(1);
    }).toPass({ timeout: 20_000 });

    await expect(rows.filter({ hasText: 'draft the brief' })).toHaveClass(/done/);

    // The click saved the note: after a reload the index still says done.
    await page.reload();
    const reloaded = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    await expect(
      reloaded.locator('.task', { hasText: 'draft the brief' }),
    ).toHaveClass(/done/);
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
