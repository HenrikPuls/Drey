import { test, expect, type Page } from './fixtures/drey';

/**
 * ADR-0020 "Later change": the Appearance category uses the shared draft /
 * Save / Discard flow like every other category -- changes preview live
 * but reach disk only on Save, and Discard rolls the preview back.
 */
const accentVar = (page: Page): Promise<string> =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase(),
  );

async function openAppearance(page: Page): Promise<void> {
  await page.locator('app-status-bar .settings').click();
  await page.locator('app-settings .category', { hasText: 'Appearance' }).click();
  await expect(page.locator('app-settings-appearance')).toBeVisible();
}

test('Appearance: live preview, Save to commit, Discard reverts', async ({ page }) => {
  await openAppearance(page);

  expect(await accentVar(page)).toBe('#c96442'); // default terracotta
  await expect(page.locator('app-settings .actions-bar .saved')).toBeVisible();
  await expect(page.locator('app-settings .actions-bar button.primary')).toBeDisabled();

  // Pick "Sage" -> previews immediately, dirties the draft, enables Save.
  await page.locator('app-settings .swatch[title="Sage"]').click();
  await expect.poll(() => accentVar(page)).toBe('#7d8f6e');
  await expect(page.locator('app-settings .actions-bar .dirty')).toBeVisible();
  await expect(page.locator('app-settings .actions-bar button.primary')).toBeEnabled();

  // Discard from the footer -> unsaved-changes bar -> Discard -> preview rolls back.
  await page.locator('app-settings .actions-bar button.ghost', { hasText: 'Discard' }).click();
  await page.locator('app-settings .unsaved button.danger', { hasText: 'Discard' }).click();
  await expect(page.locator('app-settings')).toHaveCount(0);
  await expect.poll(() => accentVar(page)).toBe('#c96442');

  // Reopen: default is back, nothing was persisted.
  await openAppearance(page);
  await expect(page.locator('app-settings .swatch[title="Terracotta"]')).toHaveClass(/active/);

  // Change again and Save from the footer -> persists, footer goes clean.
  await page.locator('app-settings .swatch[title="Sage"]').click();
  await page.locator('app-settings .actions-bar button.primary').click();
  await expect(page.locator('app-settings .actions-bar .saved')).toBeVisible();
  await page.locator('app-settings .close').click();
  await expect(page.locator('app-settings')).toHaveCount(0);
  expect(await accentVar(page)).toBe('#7d8f6e');

  // And it sticks on the next open.
  await openAppearance(page);
  await expect(page.locator('app-settings .swatch[title="Sage"]')).toHaveClass(/active/);
});
