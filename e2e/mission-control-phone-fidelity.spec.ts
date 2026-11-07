/**
 * Wave row 4.5: stands the built Mission Control in the state each phone board
 * draws and writes the screenshot to test-results/fidelity/<Board>.png, for
 * boards/compare.html. 390×844 at device scale factor 1, with the iPhone's
 * safe areas (47 / 34) the boards reserve, emulated over CDP so the app's real
 * env(safe-area-inset-*) rules are what is measured. The clock is fixed so the
 * sample's times read as on the boards. Prerequisite: npm run build:mission-control.
 */
import { test, expect, type Page } from '@playwright/test';
import { startFakeDesk } from './fixtures/mission-control-fake-desk';

let desk: Awaited<ReturnType<typeof startFakeDesk>>;
const OUT = process.env['FID_OUT'] ?? 'test-results/fidelity';

test.beforeAll(async () => {
  desk = await startFakeDesk({ boards: true });
});
test.afterAll(async () => {
  await desk.stop();
});

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, locale: 'en-GB' });

async function open(page: Page, origin = desk.origin): Promise<void> {
  await page.clock.setFixedTime(new Date(2026, 10, 7, 14, 10));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 47, left: 0, bottom: 34, right: 0 } });
  await page.goto(`${origin}/#token=e2e-device-token`);
  await expect(page.locator('mc-root .shell')).toBeVisible();
  await expect(page.locator('mc-menu')).toBeVisible();
  await settle(page);
}

const settle = (page: Page) => page.waitForTimeout(350);
const shot = async (page: Page, board: string) => {
  await settle(page);
  await page.screenshot({ path: `${OUT}/${board}.png` });
};
const place = (page: Page, name: string) => page.locator('mc-menu .places .row', { hasText: name }).click();

test('10b menu', async ({ page }) => {
  await open(page);
  await page.locator('mc-menu .chats .sess').first().click();
  await page.locator('mc-chat mc-app-bar button.back').click();
  await shot(page, 'MPhoneMenu');
});

test('10c work', async ({ page }) => {
  await open(page);
  await place(page, 'Work');
  await shot(page, 'MPhoneWork');
});

test('10t sheet', async ({ page }) => {
  // Its own desk: the switch stays Paused for whoever asks next.
  const own = await startFakeDesk({ boards: true });
  await open(page, own.origin);
  await place(page, 'Work');
  await page.locator('mc-work mc-autopilot-button button').first().click();
  await page.getByRole('radio', { name: /^Paused/ }).click();
  await expect(page.getByRole('radio', { name: /^Paused/ })).toHaveAttribute('aria-checked', 'true');
  await page.locator('mc-autopilot-panel input[type="time"]').fill('18:00');
  await shot(page, 'Autopilot-phone');
  await own.stop();
});

test('10d ticket', async ({ page }) => {
  await open(page);
  await place(page, 'Work');
  await page.locator('mc-work').getByText('Outline: drag headings to reorder').click();
  await expect(page.locator('.ticket-layer.open')).toBeVisible();
  await settle(page);
  await page.getByRole('radio', { name: /Move the whole section/ }).click();
  await shot(page, 'MPhoneTicket');
});

test('10o ready', async ({ page }) => {
  await open(page);
  await place(page, 'Work');
  await page.locator('mc-work').getByText('Palette opens twice on slow CI').click();
  await expect(page.locator('.ticket-layer.open')).toBeVisible();
  await shot(page, 'MPhoneReady');
});

test('10j plan', async ({ page }) => {
  await open(page);
  await place(page, 'Work');
  await page.locator('mc-work').getByText('Voice capture for tickets').click();
  await expect(page.locator('mc-plan-approve')).toBeVisible();
  await settle(page);
  await page.getByRole('radio', { name: /Keep the raw text/ }).click();
  await shot(page, 'MPhonePlan');
});

test('10a chat', async ({ page }) => {
  await open(page);
  await page.locator('mc-menu .chats .sess').first().click();
  await expect(page.locator('mc-chat')).toBeVisible();
  await settle(page);
  await page.getByRole('radio', { name: /Move the whole section/ }).click();
  await shot(page, 'MPhoneChat');
});

test('10m proposal', async ({ page }) => {
  await open(page);
  await page.locator('mc-menu .chats .sess', { hasText: 'T-0091' }).click();
  await expect(page.locator('mc-chat')).toBeVisible();
  await shot(page, 'MPhoneProposal');
});

test('10g settings, 10h appearance', async ({ page }) => {
  await open(page);
  await place(page, 'Settings');
  await shot(page, 'MPhoneSettings');
  await page.locator('mc-settings .ph-row', { hasText: 'Appearance' }).click();
  await shot(page, 'MPhoneAppearance');
});

test('10i crew', async ({ page }) => {
  await open(page);
  await place(page, 'Crew');
  await shot(page, 'MPhoneTeam');
});

test('10k notes, 10l note, 10p edit', async ({ page }) => {
  await open(page);
  await place(page, 'Notes');
  await shot(page, 'MPhoneNotes');
  await page.locator('mc-notes').getByText('Outline ideas').first().click();
  await shot(page, 'MPhoneNote');
  await page.locator('mc-note button.edit').click();
  await settle(page);
  await page.locator('mc-note .cm-line', { hasText: 'Alt-drag' }).click({ position: { x: 120, y: 10 } });
  await page.keyboard.press('End');
  await shot(page, 'MPhoneNoteEdit');
});

test('ends of the long screens', async ({ page }) => {
  const toEnd = (selector: string) => page.locator(selector).first().evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await open(page);
  await place(page, 'Crew');
  await settle(page);
  await toEnd('mc-team .ph-scroll');
  await shot(page, 'MPhoneTeam-end');
  await page.locator('mc-team mc-app-bar button.back').click();
  await place(page, 'Work');
  await page.locator('mc-work').getByText('Palette opens twice on slow CI').click();
  await expect(page.locator('.ticket-layer.open')).toBeVisible();
  await settle(page);
  await toEnd('mc-ticket .ph-scroll');
  await shot(page, 'MPhoneReady-end');
  await page.locator('.ticket-layer mc-app-bar button.back').first().click();
  await page.locator('mc-work').getByText('Outline: drag headings to reorder').click();
  await settle(page);
  await toEnd('mc-ticket .ph-scroll');
  await shot(page, 'MPhoneTicket-end');
});
