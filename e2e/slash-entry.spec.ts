import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * Capture through the `/` menu (milestone 43, ADR-0057 — it replaced the
 * "Add entry" drawer): the built-in Entry block leads the Templates
 * section, shows a preview card, and inserts the configured entry format;
 * a vault template is offered next to it.
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
  await expect(options.filter({ hasText: 'standup' })).toHaveCount(1);
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
