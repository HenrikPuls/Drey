import { test, expect } from './fixtures/drey';

/**
 * Configurable shortcuts (milestone 75, ADR-0073): a chord recorded in
 * Settings → Keyboard shortcuts runs the command, the old chord no longer
 * does, and the menus print the new one.
 */

test.describe('Keyboard shortcuts (ADR-0073)', () => {
  test('a rebound command runs on its new chord and the View menu shows it', async ({ page }) => {
    await page.locator('app-status-bar .settings').click();
    await page.locator('app-settings .category', { hasText: 'Keyboard shortcuts' }).click();

    const row = page.locator('app-settings-shortcuts .shortcuts li', { hasText: 'Command palette' });
    await row.getByRole('button', { name: 'Change' }).click();
    await expect(row.locator('.chord')).toHaveText('Press the new keys…');
    await page.keyboard.press('Control+Alt+J');
    await expect(row.locator('.chord')).toHaveText('Ctrl Alt J');

    // Leaving Settings saves; the registry follows the stored config.
    await page.keyboard.press('Escape');
    await expect(page.locator('app-settings')).toHaveCount(0);

    const palette = page.locator('app-palette .palette');
    await page.keyboard.press('Control+Shift+P');
    await expect(palette).toHaveCount(0);
    await page.keyboard.press('Control+Alt+J');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);

    await page.locator('app-titlebar .menu-label', { hasText: 'View' }).click();
    await expect(
      page.locator('app-titlebar .popover .row', { hasText: 'Command palette' }).locator('.hint'),
    ).toHaveText('Ctrl Alt J');
  });

  test('a chord another command holds is offered with Replace', async ({ page }) => {
    await page.locator('app-status-bar .settings').click();
    await page.locator('app-settings .category', { hasText: 'Keyboard shortcuts' }).click();

    const row = page.locator('app-settings-shortcuts .shortcuts li', { hasText: 'New note' });
    await row.getByRole('button', { name: 'Change' }).click();
    await page.keyboard.press('Control+S');
    await expect(row).toContainText('is held by “Save”');
    await row.getByRole('button', { name: 'Replace' }).click();

    await expect(row.locator('.chord')).toHaveText('Ctrl S');
    const save = page
      .locator('app-settings-shortcuts .shortcuts li')
      .filter({ has: page.locator('.name', { hasText: /^Save$/ }) });
    await expect(save.locator('.chord')).toHaveText('None');
  });
});
