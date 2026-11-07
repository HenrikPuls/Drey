/**
 * Wave row 4.6: stands the built Mission Control in the state each iPad board
 * draws and writes the screenshot to test-results/fidelity/<Board>.png, for
 * boards/compare.html. 1194×834 and 834×1194 at device scale factor 1, touch,
 * with the iPad's safe areas (24 / 20) the boards reserve, emulated over CDP so
 * the app's real env(safe-area-inset-*) rules are what is measured. The clock
 * is fixed so the sample's times read as on the boards. Prerequisite:
 * npm run build:mission-control.
 */
import { test, expect, type Page } from '@playwright/test';
import { startFakeDesk } from './fixtures/mission-control-fake-desk';

let desk: Awaited<ReturnType<typeof startFakeDesk>>;
const OUT = process.env['FID_OUT'] ?? 'test-results/fidelity';

test.beforeAll(async () => {
  desk = await startFakeDesk({ boards: true, pad: true });
});
test.afterAll(async () => {
  await desk.stop();
});

async function open(page: Page, origin = desk.origin): Promise<void> {
  await page.clock.setFixedTime(new Date(2026, 10, 7, 14, 10));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 24, left: 0, bottom: 20, right: 0 } });
  await page.goto(`${origin}/#token=e2e-device-token`);
  await expect(page.locator('mc-root .shell.ipad')).toBeVisible();
  await settle(page);
}

const settle = (page: Page) => page.waitForTimeout(350);
const shot = async (page: Page, board: string) => {
  await settle(page);
  await page.screenshot({ path: `${OUT}/${board}.png` });
};
const area = (page: Page, name: string) => page.locator('mc-shell-header .sw', { hasText: name }).click();
/** The conversation of 10e: a session opened from the chats, then back to the ticket. */
const session = async (page: Page, title: string) => {
  await ticket(page, title);
  await page.locator('mc-ticket .ph-thread').click();
  await page.locator('mc-pad-chats .row').first().click();
  await settle(page);
  await page.locator('mc-chat mc-app-bar button.back').click();
  await settle(page);
};
const ticket = async (page: Page, title: string) => {
  await page.locator('mc-work .ph-trow', { hasText: title }).first().click();
  await expect(page.locator('.ticket-layer.open')).toBeVisible();
  await settle(page);
};

test.describe('landscape', () => {
  test.use({ viewport: { width: 1194, height: 834 }, deviceScaleFactor: 1, hasTouch: true, locale: 'en-GB' });

  test('10e work', async ({ page }) => {
    await open(page);
    await session(page, 'Outline: drag headings to reorder');
    await page.getByRole('radio', { name: /Move the whole section/ }).click();
    await shot(page, 'MPadWork');
  });

  test('10q ready', async ({ page }) => {
    await open(page);
    await ticket(page, 'Palette opens twice on slow CI');
    await page.getByRole('radio', { name: /Accept and merge/ }).click();
    await shot(page, 'MPadReady');
  });

  test('5b shape, 5c plan', async ({ page }) => {
    await open(page);
    await ticket(page, 'Voice capture for tickets');
    await shot(page, 'PadShape');
    await shot(page, 'PadPlan');
  });

  test('5d crew', async ({ page }) => {
    await open(page);
    await area(page, 'Crew');
    await settle(page);
    await page.locator('mc-team').getByText('Paul').first().click();
    await shot(page, 'PadTeam');
  });

  test('5f settings', async ({ page }) => {
    await open(page);
    await page.locator('mc-shell-header').getByRole('button', { name: 'Settings' }).click();
    await shot(page, 'PadSettings');
  });

  test('5h review', async ({ page }) => {
    await open(page);
    await ticket(page, 'Palette opens twice on slow CI');
    await page.locator('mc-ticket').getByRole('button', { name: 'Review', exact: true }).first().click();
    await shot(page, 'PadReview');
  });

  test('10f chat', async ({ page }) => {
    await open(page);
    await ticket(page, 'Outline: drag headings to reorder');
    await page.locator('mc-ticket .ph-thread').click();
    await page.locator('mc-pad-chats .row').first().click();
    await settle(page);
    await page.getByRole('radio', { name: /Move the whole section/ }).click();
    await shot(page, 'MPadChat');
  });

  test('10n notes, 10r edit', async ({ page }) => {
    await open(page);
    await area(page, 'Notes');
    await settle(page);
    await page.locator('mc-notes').getByText('Outline ideas').first().click();
    await shot(page, 'MPadNotes');
    await page.locator('mc-note button.edit').click();
    await settle(page);
    await page.locator('mc-note .cm-line', { hasText: 'Open points' }).click({ position: { x: 120, y: 10 } });
    await page.keyboard.press('End');
    await shot(page, 'MPadNotesEdit');
  });

  test('10t chip', async ({ page }) => {
    const own = await startFakeDesk({ boards: true, pad: true });
    await open(page, own.origin);
    await page.locator('mc-autopilot-chip button').first().click();
    await page.getByRole('radio', { name: /^Paused/ }).click();
    await expect(page.getByRole('radio', { name: /^Paused/ })).toHaveAttribute('aria-checked', 'true');
    await page.locator('mc-autopilot-panel input[type="time"]').fill('18:00');
    await shot(page, 'Autopilot-ipad');
    await own.stop();
  });
});

test.describe('portrait', () => {
  test.use({ viewport: { width: 834, height: 1194 }, deviceScaleFactor: 1, hasTouch: true, locale: 'en-GB' });

  test('10s portrait', async ({ page }) => {
    await open(page);
    await ticket(page, 'Outline: drag headings to reorder');
    await shot(page, 'MPadPortrait');
  });
});
