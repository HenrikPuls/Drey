import { test, expect, type Page } from './fixtures/drey';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Tags plugin's Search panel after the milestone-33 redesign: scopes
 * (file / vault / all), the Aa / ab / .* match toggles, an inline error for
 * a broken regex, per-file grouped results, replace (buffer patch in file
 * scope, one bundled confirmation for the vault), and the Settings → Tags
 * prefix colors recoloring pills live. Text search finds UNTAGGED notes —
 * that was the long-standing "search is broken" defect.
 *
 * The notes are seeded before launch (`seedVault`): the vault index builds
 * in the background after plugin activation, and the assertions poll until
 * the first sweep landed.
 */

const TAGGED = [
  '# Sailing log',
  '',
  '## Morning #sailing',
  '',
  'Went out early, flat water.',
  '',
  '## Evening',
  '',
  'Sunset watch, no #sailing needed.',
  '',
].join('\n');

const PLAIN = ['# Plain notes', '', '## Groceries', '', 'Buy flat peaches and bread.', ''].join(
  '\n',
);

const MERGE = ['# Merge note', '', '## Link list', '', 'Ref #alpha and #beta here.', ''].join('\n');

test.use({
  seedVault: { 'sailing.md': TAGGED, 'plain.md': PLAIN, 'merge.md': MERGE },
});

async function openSearchPanel(page: Page): Promise<void> {
  // The plugin's panel needs vertical room -- collapse the content-height
  // Calendar first so the expanded panel's hit rows stay inside its scroll
  // clip at short windows (see tasks.spec openTasksPanel).
  await page.locator('app-panel-frame .head[aria-label="Collapse Calendar"]').click();
  // The chord needs the plugin's renderer module activated (it registers
  // the `search.open` command) — wait for the widget frame to exist first.
  await expect(page.locator('app-panel-frame .head[aria-label="Expand Search"]')).toBeVisible();
  await page.keyboard.press('Control+Shift+f');
  await expect(page.locator('app-panel-frame .tag-search')).toBeVisible();
}

async function runSearch(page: Page, text: string): Promise<void> {
  const panel = page.locator('app-panel-frame', { has: page.locator('.tag-search') });
  // One field for text and #tags (milestone 43): the shared tag field's input.
  const field = panel.locator('.tag-search-field .tag-field-input').first();
  await field.fill(text);
  await field.press('Enter');
}

test.describe('Search panel (Tags plugin, milestone 33)', () => {
  test('text search finds untagged notes, grouped per file, and opens at the line', async ({
    page,
  }) => {
    await openSearchPanel(page);

    await runSearch(page, 'flat water');
    const panel = page.locator('app-panel-frame', { has: page.locator('.tag-search') });

    // Terms AND within one section: only the sailing Morning section has
    // both "flat" and "water".
    await expect(panel.locator('.tag-search-summary-text')).toHaveText(/1 section in 1 file/);

    // THE FIX under test: the untagged note is searchable at all — its only
    // section carries no inline #tag.
    await runSearch(page, 'peaches');
    await expect(panel.locator('.tag-search-summary-text')).toHaveText(/1 section in 1 file/);
    await expect(panel.locator('.tag-search-file')).toHaveCount(1);

    // Opening a hit lands in the file at the section's line.
    await panel.locator('.tag-search-hit').first().click();
    await expect(page.locator('app-editor .cm-content')).toContainText('flat peaches');
  });

  test('a broken regex shows an inline error instead of an empty panel', async ({ page }) => {
    await openSearchPanel(page);
    const panel = page.locator('app-panel-frame', { has: page.locator('.tag-search') });

    await panel.locator('.icon-btn[title="Regular expression"]').click();
    await runSearch(page, 'flat(');

    await expect(panel.locator('.tag-search-error')).toBeVisible();
    await expect(panel.locator('.tag-search-error')).not.toBeEmpty();
  });

  test('whole word narrows the match', async ({ page }) => {
    await openSearchPanel(page);
    const panel = page.locator('app-panel-frame', { has: page.locator('.tag-search') });

    // As a substring, "at" lives inside "flat"/"watch" — both files match.
    await runSearch(page, 'at');
    await expect(panel.locator('.tag-search-summary-text')).toHaveText(/3 sections in 2 files/);

    // As a whole word, "at" occurs nowhere.
    await panel.locator('.icon-btn[title="Whole word"]').click();
    await runSearch(page, 'at');
    await expect(panel.locator('.tag-search-empty')).toHaveText('No matches.');
  });

  test('file scope replaces inside the open document as an unsaved buffer edit', async ({
    page,
    vaultDir,
  }) => {
    await openSearchPanel(page);
    const panel = page.locator('app-panel-frame', { has: page.locator('.tag-search') });

    // Open the file the replace should touch.
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'sailing.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toContainText('flat water');

    await panel.locator('.seg [aria-label="Search the open document"]').click();
    await runSearch(page, 'flat');
    await expect(panel.locator('.tag-search-summary-text')).toHaveText(/1 section in 1 file/);

    await panel.locator('.tag-search-summary [aria-label="Replace"]').click();
    await panel.locator('.tag-search-replace input').fill('smooth');
    await panel.locator('.tag-search-replace [aria-label="Replace all"]').click();

    // The replace patches the live buffer (like any typed edit): the tab
    // turns dirty and nothing reaches disk until the user saves.
    await expect(page.locator('app-editor .cm-content')).toContainText('smooth water');
    await expect(page.locator('app-tab-bar .dirty').first()).toBeVisible();
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, 'sailing.md'), 'utf-8'))
      .toContain('flat water');
  });

  test('vault replace goes through the bundled confirmation and writes the file', async ({
    page,
    vaultDir,
  }) => {
    await openSearchPanel(page);
    const panel = page.locator('app-panel-frame', { has: page.locator('.tag-search') });

    await runSearch(page, 'sunset');
    await expect(panel.locator('.tag-search-summary-text')).toHaveText(/1 section in 1 file/);

    await panel.locator('.tag-search-summary [aria-label="Replace"]').click();
    await panel.locator('.tag-search-replace input').fill('sunrise');
    await panel.locator('.tag-search-replace [aria-label="Replace all"]').click();

    // The bundled confirmation lists the affected file before anything lands.
    // (The host's modal box carries both classes — `plugin-modal` + the
    // page's own.)
    const modal = page.locator('.plugin-modal.tag-search-modal');
    await expect(modal).toBeVisible();
    await expect(modal.locator('.tag-search-modal-path')).toHaveText('sailing.md');

    await modal.locator('button', { hasText: 'Replace all' }).click();
    await expect(modal).toHaveCount(0);
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, 'sailing.md'), 'utf-8'))
      .toContain('sunrise watch');
  });
});

test.describe('Tags settings (prefix colors)', () => {
  test('a configured prefix recolors tag chips without a restart', async ({ page }) => {
    // Settings via the status-bar entry.
    await page.locator('app-status-bar .settings').click();
    await page.locator('app-settings .category', { hasText: 'Tags' }).click();

    // The plugin settings host's body IS the `.tags-settings` element (the
    // page adds its class to it), so select it directly.
    const pane = page.locator('app-settings .plugin-settings-body.tags-settings');
    await pane.locator('button', { hasText: '+ Add prefix' }).click();
    await pane.locator('.tags-settings-prefix').first().fill('sailing');
    // Enter commits the prefix (normalize + persist), like blurring it.
    await pane.locator('.tags-settings-prefix').first().press('Enter');
    await pane.locator('.tags-settings-color').first().fill('#123456');

    await page.locator('app-settings .close').click();
    await expect(page.locator('app-settings')).toHaveCount(0);

    // A tag pill for #sailing now renders with the configured hue (inline
    // `--tag-hue`, which the theme's color-mix consumes). Polled: the
    // recolor rides the search:changed push → vocabulary re-pull.
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'sailing.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();
    const pill = page.locator('app-editor .cm-tag-pill[data-tag="sailing"]').first();
    await expect(pill).toBeVisible();
    await expect(async () => {
      const style = await pill.getAttribute('style');
      expect(style).toContain('#123456');
    }).toPass({ timeout: 10_000 });
  });

  test('rename rewrites the tag across the vault (milestone 53)', async ({ page, vaultDir }) => {
    await page.locator('app-status-bar .settings').click();
    await page.locator('app-settings .category', { hasText: 'Tags' }).click();
    const pane = page.locator('app-settings .plugin-settings-body.tags-settings');

    // The tag list lands when the index's boot sweep has finished.
    const row = pane.locator('.tags-settings-tag-row', { hasText: 'sailing' });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('button', { hasText: 'Rename…' }).click();

    const modal = page.locator('.plugin-modal.tags-rename-modal');
    await expect(modal).toBeVisible();
    await modal.locator('.tags-settings-rename-input').fill('segeln');
    await modal.locator('button', { hasText: 'Preview' }).click();

    const apply = modal.locator('button', { hasText: 'Rename' });
    await expect(apply).toBeVisible();
    await apply.click();
    await expect(modal).toHaveCount(0);

    // Both occurrences in the file on disk are rewritten.
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, 'sailing.md'), 'utf-8'))
      .toContain('#segeln');
    const content = fs.readFileSync(path.join(vaultDir, 'sailing.md'), 'utf-8');
    expect(content).not.toContain('#sailing');
  });

  test('a merge drops the duplicate it would create (milestone 53)', async ({ page, vaultDir }) => {
    await page.locator('app-status-bar .settings').click();
    await page.locator('app-settings .category', { hasText: 'Tags' }).click();
    const pane = page.locator('app-settings .plugin-settings-body.tags-settings');

    const row = pane.locator('.tags-settings-tag-row', { hasText: 'alpha' });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('button', { hasText: 'Rename…' }).click();

    const modal = page.locator('.plugin-modal.tags-rename-modal');
    await expect(modal).toBeVisible();
    await modal.locator('.tags-settings-rename-input').fill('beta');
    await modal.locator('button', { hasText: 'Preview' }).click();

    // The target exists — the modal switches to merge wording.
    await expect(modal.locator('.tag-search-modal-title')).toHaveText(/Merge #alpha into #beta/);
    await modal.locator('button', { hasText: 'Merge' }).click();
    await expect(modal).toHaveCount(0);

    // One #beta token stays (the newcomer position wins, prose untouched);
    // #alpha is gone.
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, 'merge.md'), 'utf-8'))
      .toContain('Ref #beta and here.');
    const content = fs.readFileSync(path.join(vaultDir, 'merge.md'), 'utf-8');
    expect(content).not.toContain('#alpha');
    expect(content.match(/#beta/g)?.length).toBe(1);
  });
});
