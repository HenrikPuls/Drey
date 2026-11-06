import { test, expect, type Page } from './fixtures/drey';

/**
 * E13-22 (board 7g): Settings like VS Code -- one page width, a section tree
 * with counts, a search across all pages, scope tabs.
 */
const open = async (page: Page): Promise<void> => {
  await page.locator('app-status-bar .settings').click();
  await expect(page.locator('app-settings .category').first()).toBeVisible();
};

const paneWidth = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const pane = document.querySelector('app-settings .detail > *');
    return Math.round(pane?.getBoundingClientRect().width ?? 0);
  });

test('every page is the same width', async ({ page }) => {
  await open(page);
  const widths = new Set<number>();
  for (const label of ['Appearance', 'Vault', 'Actions']) {
    await page.locator('app-settings .category', { hasText: label }).first().click();
    await page.waitForTimeout(150);
    widths.add(await paneWidth(page));
  }
  expect([...widths]).toHaveLength(1);
});

test('counts show, search says what is missing and clears, scope tabs list a scope', async ({ page }, info) => {
  await open(page);
  await expect(page.locator('app-settings .category .count').first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('settings.png') });

  await page.locator('app-settings input[type="search"]').fill('zzzqq');
  await expect(page.locator('app-settings .no-match')).toContainText('No setting matches "zzzqq"');
  await page.locator('app-settings .no-match button').click();
  await expect(page.locator('app-settings .no-match')).toHaveCount(0);

  await page.locator('app-settings .scope-tab', { hasText: 'This vault' }).click();
  await expect(page.locator('app-settings .result').first()).toBeVisible();
});
