import { test, expect, type Page } from './fixtures/drey';

/**
 * The Tasks mode of the Find panel (ADR-0044 stage 6, req-161): its note /
 * whole-vault scopes (the panel's "Look in" menu), the row checkbox writing
 * back into the note, the kind choice and the shared field, and the persisted
 * scope. (`Mod+Enter` is covered by the pane/editor specs' keymap
 * expectations; the scanner and filter logic has unit specs.)
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
  // The content-height Calendar would leave the opened panel's first rows
  // under its scroll clip at short windows -- close it first so the panel
  // gets room at any window height.
  await page.locator('app-dock-strip button[aria-label="Hide Calendar"]').click();
  // The plugin's panel: closed by default, its strip icon opens it.
  await page.locator('app-dock-strip button[aria-label="Show Find"]').click();
  await page.locator('.find-tab', { hasText: 'Tasks' }).click();
  await expect(page.locator('app-panel-frame .find-tasks')).toBeVisible();
  // Done tasks are hidden by default (board 9c); these specs count them.
  await pickMenu(page, 'Show done');
}

const panelOf = (page: Page) => page.locator('app-panel-frame', { has: page.locator('.find') });

/** Picks a row of the panel's ⋯ menu. */
async function pickMenu(page: Page, label: string): Promise<void> {
  await panelOf(page).locator('.head').hover();
  await panelOf(page).locator('button[aria-label="More"]').click();
  await page.locator('.find-menu-item', { hasText: label }).click();
}

test.describe('Tasks mode of the Find panel', () => {
  test('note scope lists the live buffer and ticking a row rewrites the note', async ({ page }) => {
    await openTasksPanel(page);
    await pickMenu(page, 'This note');

    const panel = panelOf(page);
    const rows = panel.locator('.find-task');
    await expect(rows).toHaveCount(3);
    await expect(rows.locator('.find-task-title')).toHaveText([
      'draft the brief',
      'send the invoice',
      'Fix the roof',
    ]);
    await expect(panel.locator('.head .status')).toHaveText('2 open in this note');
    // The `#task` line carries its kind (kind choice default: both on).
    await expect(rows.filter({ hasText: 'Fix the roof' }).locator('.find-task-kind')).toHaveText('#task');

    // Tick the first row's checkbox: the open buffer gains the `x` and saves.
    // (Live Preview renders the box as a widget -- the done-task text gets
    // the `lp-task-done` decoration, same hook menu-and-dock.spec asserts.)
    await rows.filter({ hasText: 'draft the brief' }).locator('.find-task-box').click();
    await expect(
      page.locator('app-editor .cm-content .lp-task-done', { hasText: 'draft the brief' }),
    ).toHaveCount(1);
    await expect(panel.locator('.head .status')).toHaveText('1 open in this note');
    // The row follows the buffer (note scope scans the live editor).
    await expect(rows.filter({ hasText: 'draft the brief' })).toHaveClass(/done/);
  });

  test('vault scope: ticking rows back-to-back keeps every row done (regression)', async ({
    page,
  }) => {
    await openTasksPanel(page);

    const panel = panelOf(page);
    const rows = panel.locator('.find-task');
    await expect(rows).toHaveCount(4); // 3 in tasks-demo.md (1 done) + 1 in other.md

    // Tick the three open ones back-to-back, without waiting for the list
    // between clicks -- the old silent save drop lost every tick that
    // landed while the previous save was still running, and the next list
    // pull "reset" the rows to open.
    await rows.filter({ hasText: 'draft the brief' }).locator('.find-task-box').click();
    await rows.filter({ hasText: 'Fix the roof' }).locator('.find-task-box').click();
    await rows.filter({ hasText: 'water the plants' }).locator('.find-task-box').click();

    await expect(rows.filter({ hasText: 'draft the brief' })).toHaveClass(/done/);
    await expect(rows.filter({ hasText: 'Fix the roof' })).toHaveClass(/done/);
    await expect(rows.filter({ hasText: 'water the plants' })).toHaveClass(/done/);

    // And they reached DISK, not just the open buffers: after a reload the
    // rebuilt index still reports every row done.
    await page.reload();
    await page.locator('.find-tab', { hasText: 'Tasks' }).click();
    const reloadedRows = panelOf(page).locator('.find-task');
    await expect(reloadedRows.filter({ hasText: 'draft the brief' })).toHaveClass(/done/);
    await expect(reloadedRows.filter({ hasText: 'Fix the roof' })).toHaveClass(/done/);
    await expect(reloadedRows.filter({ hasText: 'water the plants' })).toHaveClass(/done/);
    await expect(reloadedRows).toHaveCount(4); // the pre-done one still lists too
  });

  test('clicking the checkbox in the editor reaches the vault list and disk', async ({ page }) => {
    await openTasksPanel(page);

    const rows = panelOf(page).locator('.find-task');
    await expect(rows.filter({ hasText: 'draft the brief' })).toHaveCount(1);

    // Click the rendered checkbox in Live Preview -- no Ctrl+S anywhere.
    // (This used to only dirty the buffer: the vault list, a disk index,
    // never adopted it until an unrelated save.) The click gesture can be
    // swallowed by an in-flight decoration rebuild right after the tab opens
    // -- retry click and effect as ONE unit; the first effective click wins.
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
    await page.locator('.find-tab', { hasText: 'Tasks' }).click();
    await expect(
      panelOf(page).locator('.find-task', { hasText: 'draft the brief' }),
    ).toHaveClass(/done/);
  });

  test('the kind choice and the free-text field narrow the note list', async ({ page }) => {
    await openTasksPanel(page);
    await pickMenu(page, 'This note');

    const panel = panelOf(page);
    const rows = panel.locator('.find-task');
    await expect(rows).toHaveCount(3);

    // `#task lines` off: only the checkboxes remain.
    await pickMenu(page, '#task lines');
    await expect(rows).toHaveCount(2);

    // Free text narrows further, and Clear appears.
    await panel.locator('.find-field .tag-field-input').first().fill('invoice');
    await expect(rows).toHaveCount(1);
    await expect(rows.filter({ hasText: 'send the invoice' })).toHaveCount(1);
    await panel.locator('.find-field [aria-label="Clear"]').click();
    await expect(rows).toHaveCount(2);
  });

  test('vault scope groups by file and the scope choice persists across a reload', async ({
    page,
  }) => {
    await openTasksPanel(page);

    // Grouped by file: name and folder in the 28 px head.
    const panel = panelOf(page);
    const groups = panel.locator('.find-group');
    await expect(groups).toHaveCount(2);
    await expect(groups.filter({ hasText: 'tasks-demo.md' })).toHaveCount(1);
    await expect(groups.filter({ hasText: 'other.md' })).toHaveCount(1);

    // The scope survives a reload (the panel's `localStorage['drey.search']`).
    await pickMenu(page, 'All vaults');
    await page.reload();
    await page.locator('.find-tab', { hasText: 'Tasks' }).click();
    await panelOf(page).locator('.head').hover();
  await panelOf(page).locator('button[aria-label="More"]').click();
    await expect(
      page.locator('.find-menu-item[aria-checked="true"]', { hasText: 'All vaults' }),
    ).toHaveCount(1);
  });
});
