import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * Capture through the `/` menu (milestone 43, ADR-0057 — it replaced the
 * "Add entry" drawer): the built-in Entry block leads the Templates
 * section, shows a preview card, and inserts the configured entry format;
 * a vault template completes by its typed name, and the "Templates…" row
 * opens the template picker (req-41).
 */
test('the slash menu offers Entry and vault templates, previews and inserts them', async ({
  page,
  vaultDir,
}) => {
  fs.mkdirSync(path.join(vaultDir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'templates', 'standup.md'), '## Standup\n\n- yesterday\n');
  fs.writeFileSync(path.join(vaultDir, 'note.md'), '# Note\n\n');
  await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'note.md' }).click();
  const content = page.locator('app-editor .cm-content');
  await expect(content).toBeVisible();

  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('/');

  const menu = page.locator('app-editor .cm-tooltip-autocomplete');
  await expect(menu).toBeVisible();
  const options = menu.locator('ul > li');
  await expect(options.first()).toContainText('Entry');
  // A bare slash lists no template by name -- the library may be large;
  // one row opens the template picker instead (req-41).
  await expect(options.filter({ hasText: 'Templates…' })).toHaveCount(1);
  await expect(options.filter({ hasText: 'standup' })).toHaveCount(0);
  await expect(options.filter({ hasText: 'Heading 1' })).toHaveCount(1);
  await expect(menu.locator('completion-section').first()).toHaveText('Templates');

  // The selected row's preview card: the block as it would be inserted.
  await expect(page.locator('app-editor .slash-preview-body')).toHaveText(/^## \d{2}:\d{2}\s*$/);

  // CodeMirror ignores an accept in the first moments after the popup
  // changed (its interaction delay, a guard against accidental Enter).
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await expect(content).toContainText(/\d{2}:\d{2}/);
  await page.keyboard.type(' Urlaub-Ideen');
  await expect(content).toContainText('Urlaub-Ideen');

  // A vault template through the same menu.
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n/stand');
  await expect(options.filter({ hasText: 'standup' })).toHaveCount(1);
  await expect(page.locator('app-editor .slash-preview-body')).toContainText('yesterday');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await expect(content).toContainText('yesterday');

  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(() => fs.readFileSync(path.join(vaultDir, 'note.md'), 'utf-8'))
    .toMatch(/## \d{2}:\d{2} Urlaub-Ideen[\s\S]*## Standup\n\n- yesterday/);
});

test('the slash menu opens the template picker: folders, no prompts, arrow keys', async ({
  page,
  vaultDir,
}) => {
  const templates = path.join(vaultDir, 'templates');
  fs.mkdirSync(path.join(templates, 'meetings'), { recursive: true });
  fs.mkdirSync(path.join(templates, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(templates, 'standup.md'), '## Standup\n\n- yesterday\n');
  fs.writeFileSync(path.join(templates, 'meetings', 'sync.md'), '## Sync\n\n- agenda\n');
  fs.writeFileSync(path.join(templates, 'prompts', 'review.md'), '# Review\n> a composer prompt\n');
  fs.writeFileSync(path.join(vaultDir, 'note.md'), '# Note\n\n');
  await page.locator('app-dock[side="left"] .hdr-btn[aria-label="Refresh files"]').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'note.md' }).click();
  const content = page.locator('app-editor .cm-content');
  await expect(content).toBeVisible();

  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('/tem');
  const menu = page.locator('app-editor .cm-tooltip-autocomplete');
  await expect(menu.locator('ul > li', { hasText: 'Templates…' })).toHaveCount(1);
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');

  // The picker floats at the caret; the typed command is gone.
  const picker = page.locator('.tpl-pick-float');
  await expect(picker).toBeVisible();
  await expect(content).not.toContainText('/tem');
  const names = picker.locator('.tpl-pick-row .tpl-pick-name');
  // Root file, then the folder with its template; prompts/ is left out.
  await expect(names).toHaveText(['standup', 'meetings', 'sync']);
  await expect(picker.locator('.tpl-pick-input')).toBeFocused();
  await expect(picker.locator('.tpl-pick-body')).toContainText('yesterday');

  // Keyboard only: down to the template inside the folder, Enter inserts.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(picker.locator('.tpl-pick-row.active .tpl-pick-name')).toHaveText('sync');
  await expect(picker.locator('.tpl-pick-body')).toContainText('agenda');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(content).toContainText('agenda');

  // The same picker sits at the leading edge of the formatting strip;
  // typing filters, Escape closes without inserting.
  await page.locator('app-editor app-markdown-toolbar button[aria-label="Insert template"]').click();
  const popover = page.locator('app-editor app-markdown-toolbar .plugin-pop');
  await expect(popover).toBeVisible();
  await page.keyboard.type('stand');
  await expect(popover.locator('.tpl-pick-row .tpl-pick-name')).toHaveText(['standup']);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(content).not.toContainText('yesterday');
});
