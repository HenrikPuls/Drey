import { test, expect } from './fixtures/drey';

/**
 * The titlebar's dock toggles: each folds its whole side dock away and
 * brings it back, by click and by chord; revealing a panel unfolds its dock.
 */
test.describe('folding the side docks', () => {
  test('the titlebar toggles fold and unfold each side dock', async ({ page }) => {
    const left = page.locator('app-dock[side="left"]');
    const right = page.locator('app-dock[side="right"]');
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();

    await page.locator('app-titlebar button[aria-label="Hide left dock"]').click();
    await expect(left).toBeHidden();
    await expect(right).toBeVisible();
    await expect(page.locator('.divider[aria-label="Resize left dock"]')).toHaveCount(0);

    await page.locator('app-titlebar button[aria-label="Hide right dock"]').click();
    await expect(right).toBeHidden();
    await page.screenshot({ path: test.info().outputPath('docks-folded.png') });

    await page.locator('app-titlebar button[aria-label="Show left dock"]').click();
    await expect(left).toBeVisible();
    await page.locator('app-titlebar button[aria-label="Show right dock"]').click();
    await expect(right).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('docks-open.png') });
  });

  test('Ctrl+B folds the left dock; opening the search unfolds it', async ({ page }) => {
    const left = page.locator('app-dock[side="left"]');
    await page.keyboard.press('Control+B');
    await expect(left).toBeHidden();

    await page.keyboard.press('Control+Shift+F');
    await expect(left).toBeVisible();
  });
});
