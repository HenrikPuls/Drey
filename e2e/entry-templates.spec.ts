import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures/drey';

/**
 * The configurable "Add entry" template: switching the active template in
 * Settings changes the block the drawer appends, end to end.
 */
test('switching to the "Ruled" template changes what the drawer appends', async ({
  page,
  vaultDir,
}) => {
  fs.writeFileSync(path.join(vaultDir, 'note.md'), '# Note\n');
  await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'note.md' }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();

  // Settings → Add entry → make "Ruled" the active template → Save.
  await page.locator('app-status-bar .settings').click();
  await page.locator('app-settings .category', { hasText: 'Add entry' }).click();
  const ruledRow = page.locator('app-settings-entry .template').nth(1);
  await expect(ruledRow.locator('.template-name')).toHaveValue('Ruled');
  await ruledRow.locator('input[type="radio"]').check();
  await page.locator('app-settings .actions-bar button.primary').click(); // Save (stays open)
  await page.locator('app-settings .close').click(); // now clean → closes
  await expect(page.locator('app-settings')).toHaveCount(0);

  // Fill and submit the drawer.
  const bottom = page.locator('app-dock[side="bottom"]');
  await bottom.locator('app-panel-frame .head').first().click();
  await bottom.locator('#entry-topic').fill('Urlaub-Ideen');
  await bottom.locator('.chip-input').fill('urlaub');
  await bottom.locator('.chip-input').press('Enter');
  await bottom.locator('app-entry-drawer .md-editor .cm-content').click();
  await page.keyboard.type('Mallorca oder Kroatien.');
  await bottom.locator('.btn.primary', { hasText: 'Add to document' }).click();

  await expect
    .poll(() => fs.readFileSync(path.join(vaultDir, 'note.md'), 'utf-8'))
    .toMatch(/## \d{2}:\d{2} — Urlaub-Ideen\n---\n#urlaub\n\nMallorca oder Kroatien\./);
});
