/**
 * E12-14 — Mission Control's Settings detail width (board 5f on the iPad, full
 * width on the phone) and the five-step text size (MPhoneAppearance). Runs the
 * built app against the fake desk, like `mission-control-shell.spec.ts`;
 * prerequisite: `npm run build:mission-control`.
 */
import { test, expect, type Page } from '@playwright/test';
import { startFakeDesk } from './fixtures/mission-control-fake-desk';

let desk: Awaited<ReturnType<typeof startFakeDesk>>;

test.beforeAll(async () => {
  desk = await startFakeDesk();
});

test.afterAll(async () => {
  await desk.stop();
});

async function openApp(page: Page): Promise<void> {
  await page.goto(`${desk.origin}/#token=e2e-device-token`);
  await expect(page.locator('mc-root .shell')).toBeVisible();
}

const width = async (page: Page, selector: string): Promise<number> =>
  (await page.locator(selector).evaluate((el) => el.getBoundingClientRect().width));

test.describe('iPad landscape (1194×834)', () => {
  test.use({ viewport: { width: 1194, height: 834 }, hasTouch: true });

  test('the Appearance page takes the middle and the right area, not a narrow column', async ({ page }) => {
    await openApp(page);
    await page.locator('mc-shell-header').getByRole('button', { name: 'Settings' }).click();
    await page.locator('mc-settings .cats .row', { hasText: 'Appearance' }).click();
    const settingsWidth = await width(page, 'mc-settings');
    const pageWidth = await width(page, 'mc-settings .page');
    expect(settingsWidth).toBeGreaterThan(800);
    expect(pageWidth).toBeGreaterThan(450);
    // The five text steps sit side by side, each at least a 44 pt target.
    const steps = page.locator('mc-settings .sizes .size');
    await expect(steps).toHaveText(['S', 'M', 'L', 'XL', 'XXL']);
    for (const box of await steps.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('Phone (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the Appearance page is full width and XXL is saved on the device', async ({ page }) => {
    await openApp(page);
    await page.locator('mc-menu .places .row', { hasText: 'Settings' }).click();
    await page.locator('mc-settings .cats .row', { hasText: 'Appearance' }).click();
    expect(await width(page, 'mc-settings .page')).toBeGreaterThanOrEqual(388);
    const steps = page.locator('mc-settings .sizes .size');
    await expect(steps).toHaveCount(5);
    await steps.nth(4).click();
    expect(await page.evaluate(() => localStorage.getItem('mc.textSize'))).toBe('XXL');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--mc-text'))).toBe(String(21 / 15));
    await page.reload();
    await expect(page.locator('mc-root .shell')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--mc-text'))).toBe(String(21 / 15));
  });
});
