/**
 * req-95b — Mission Control's Autopilot clients (canvas board 10t): the iPad
 * chip with its popover, the phone's app-bar button with its sheet. Runs the
 * built app against the fake desk in a stock Chromium (no engine); the desk
 * can refuse the write the way the engine does, so the spec checks that a
 * refusal reads as words, never as a code. Prerequisite:
 * `npm run build:mission-control`.
 */
import { test, expect, type Page } from '@playwright/test';
import { startFakeDesk } from './fixtures/mission-control-fake-desk';

type Desk = Awaited<ReturnType<typeof startFakeDesk>>;

async function openApp(page: Page, desk: Desk): Promise<void> {
  await page.goto(`${desk.origin}/#token=e2e-device-token`);
  await expect(page.locator('mc-root .shell')).toBeVisible();
}

test.describe('iPad: the header chip', () => {
  test.use({ viewport: { width: 1194, height: 834 }, hasTouch: true });

  test('shows the state, switches it and leaves a trace on the desk', async ({ page }) => {
    const desk = await startFakeDesk();
    try {
      await openApp(page, desk);
      const chip = page.locator('mc-shell-header mc-autopilot-chip .chip');
      await expect(chip).toHaveText(/Autopilot · On/);
      expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await chip.click();
      await page.getByRole('radio', { name: 'Off' }).click();
      await expect(chip).toHaveText(/Autopilot · Off/);
      expect(desk.autopilotWrites()).toEqual([{ state: 'off' }]);
    } finally {
      await desk.stop();
    }
  });

  test('a refused write says why in words', async ({ page }) => {
    const desk = await startFakeDesk({ refuseAutopilot: 'read_only' });
    try {
      await openApp(page, desk);
      await page.locator('mc-shell-header mc-autopilot-chip .chip').click();
      await page.getByRole('radio', { name: 'Paused' }).click();
      const alert = page.getByRole('alert');
      await expect(alert).toHaveText('This device is paired read-only, so it cannot change the Autopilot.');
      await expect(alert).not.toContainText('read_only');
    } finally {
      await desk.stop();
    }
  });

  test('a read-only device sees the state and every control is disabled', async ({ page }) => {
    const desk = await startFakeDesk({ readOnly: true });
    try {
      await openApp(page, desk);
      await page.locator('mc-shell-header mc-autopilot-chip .chip').click();
      for (const name of ['On', 'Paused', 'Off']) {
        await expect(page.getByRole('radio', { name })).toBeDisabled();
      }
      await expect(page.getByRole('button', { name: /Stop all running steps now/ })).toBeDisabled();
      expect(desk.autopilotWrites()).toEqual([]);
    } finally {
      await desk.stop();
    }
  });
});

test.describe('phone: the app-bar button and its sheet', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('opens a sheet of three 56 px rows with Stop-now below', async ({ page }, testInfo) => {
    const desk = await startFakeDesk();
    try {
      await openApp(page, desk);
      // The phone's root is the menu; Work is the first place.
      await expect(page.locator('mc-menu .row.autopilot')).toHaveAccessibleName('Autopilot, On');
      await page.locator('mc-menu').getByRole('button', { name: /^Work/ }).click();
      const button = page.locator('mc-work mc-app-bar mc-autopilot-button .btn');
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await button.click();
      const sheet = page.getByRole('dialog', { name: 'Autopilot' });
      await expect(sheet.getByRole('radio')).toHaveCount(3);
      for (const row of await sheet.getByRole('radio').all()) {
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(56);
      }
      await expect(sheet.getByRole('button', { name: /Stop all running steps now/ })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('mc-phone-autopilot-sheet.png') });
    } finally {
      await desk.stop();
    }
  });
});
