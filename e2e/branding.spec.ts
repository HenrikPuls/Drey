import { test, expect } from './fixtures/drey';

/** The app mark in the titlebar, and the About pane. */
test('the titlebar shows the icon (not a plain square)', async ({ page }) => {
  const mark = page.locator('app-titlebar .brand .mark');
  await expect(mark).toHaveJSProperty('tagName', 'IMG');
  await expect(mark).toHaveJSProperty('naturalWidth', 512); // the PNG actually loaded
  // The word-mark text was removed -- the icon alone stands for the app.
  await expect(page.locator('app-titlebar .brand .name')).toHaveCount(0);
  await page.locator('app-titlebar').screenshot({ path: 'test-results/titlebar.png' });
});

test('the About pane has the mark, the copyright holder and lowercase "drey"', async ({ page }) => {
  await page.locator('app-status-bar .settings').click();
  await page.locator('app-settings .category', { hasText: 'About' }).click();

  const facts = page.locator('app-settings-about .facts');
  await expect(facts).toContainText('drey');
  await expect(facts).toContainText('© 2026 Henrik Puls');
  await expect(page.locator('app-settings-about .app-mark')).toHaveJSProperty('naturalWidth', 512);
  await expect(page.locator('app-settings-about')).toContainText('drey is licensed under');

  await page.locator('app-settings-about').screenshot({ path: 'test-results/about.png' });
});
