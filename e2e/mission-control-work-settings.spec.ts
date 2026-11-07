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
    const settingsWidth = await width(page, 'mc-settings');
    expect(settingsWidth).toBeGreaterThan(800);
    // Appearance starts open; Change… opens the existing page in place.
    await page.locator('mc-settings .pd-row', { hasText: 'Color theme' }).getByRole('button', { name: 'Change…' }).click();
    const pageWidth = await width(page, 'mc-settings .pd-page');
    expect(pageWidth).toBeGreaterThan(450);
    const slider = page.getByRole('slider', { name: 'Text size' });
    await expect(slider).toHaveAttribute('aria-valuetext', 'L, 17 px');
    const box = (await slider.boundingBox())!;
    await page.mouse.click(box.x + box.width, box.y + 22);
    await expect(slider).toHaveAttribute('aria-valuetext', 'XXL, 21 px');
    // The 44 pt target holds on what the page offers.
    for (const target of await page.locator('mc-settings .pd-page .ph-tile, mc-settings .pd-page .ph-dot').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: 'Back to settings' }).click();
    await expect(page.locator('mc-settings .pd-sec')).not.toHaveCount(0);
  });
});

test.describe('Phone (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the Appearance page is full width and XXL is saved on the device', async ({ page }) => {
    await openApp(page);
    await page.locator('mc-menu .places .row', { hasText: 'Settings' }).click();
    await page.locator('mc-settings .ph-row', { hasText: 'Appearance' }).click();
    expect(await width(page, 'mc-settings .ph-app')).toBeGreaterThanOrEqual(388);
    const slider = page.getByRole('slider', { name: 'Text size' });
    await expect(slider).toHaveAttribute('aria-valuetext', 'L, 17 px');
    const box = (await slider.boundingBox())!;
    await page.mouse.click(box.x + box.width, box.y + 22);
    await expect(slider).toHaveAttribute('aria-valuetext', 'XXL, 21 px');
    expect(await page.evaluate(() => localStorage.getItem('mc.textSize'))).toBe('XXL');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--mc-text'))).toBe(String(21 / 15));
    await page.reload();
    await expect(page.locator('mc-root .shell')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--mc-text'))).toBe(String(21 / 15));
  });
});
