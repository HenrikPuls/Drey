import { test, expect } from './fixtures/drey';

/**
 * Zen mode: the chrome-free writing view. The `view.toggleZen` command
 * (default chord `Ctrl+Alt+Z`, also the View menu's "Zen mode" row)
 * removes the titlebar, the docks and the status bar from the layout and
 * restores them unchanged on exit; the command palette stays reachable,
 * so it remains a second exit while the menu bar is hidden.
 */
test.describe('zen mode', () => {
  test('the chord hides the chrome and a second press restores it', async ({ page }) => {
    await expect(page.locator('app-titlebar')).toBeVisible();
    await expect(page.locator('app-dock[side="left"]')).toBeVisible();
    await expect(page.locator('app-status-bar')).toBeVisible();

    await page.keyboard.press('Control+Alt+Z');
    await expect(page.locator('app-titlebar')).toHaveCount(0);
    await expect(page.locator('app-dock')).toHaveCount(0);
    await expect(page.locator('app-status-bar')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('zen-on.png') });

    await page.keyboard.press('Control+Alt+Z');
    await expect(page.locator('app-titlebar')).toBeVisible();
    await expect(page.locator('app-dock[side="left"]')).toBeVisible();
    await expect(page.locator('app-status-bar')).toBeVisible();
  });

  test('zen does not touch the dock layout underneath', async ({ page }) => {
    const left = page.locator('app-dock[side="left"]');

    await page.keyboard.press('Control+B');
    await expect(left).toBeHidden();

    await page.keyboard.press('Control+Alt+Z');
    await expect(page.locator('app-titlebar')).toHaveCount(0);
    await page.keyboard.press('Control+Alt+Z');
    await expect(page.locator('app-titlebar')).toBeVisible();

    // The fold survived zen -- zen is a render gate, not a layout change.
    await expect(left).toBeHidden();
    await page.keyboard.press('Control+B');
    await expect(left).toBeVisible();
  });

  test('the command palette stays usable in zen and exits it', async ({ page }) => {
    await page.keyboard.press('Control+Alt+Z');
    await expect(page.locator('app-titlebar')).toHaveCount(0);

    // The palette overlay is outside the gated chrome -- while the menu
    // bar is hidden it is the second exit beside the chord. (The
    // `app-palette` host itself is an unstyled inline element; its
    // `.palette` dialog is the visible box.)
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('app-palette .palette')).toBeVisible();
    await page.keyboard.type('zen mode');
    await page.keyboard.press('Enter');
    await expect(page.locator('app-titlebar')).toBeVisible();
    await expect(page.locator('app-status-bar')).toBeVisible();
  });
});
