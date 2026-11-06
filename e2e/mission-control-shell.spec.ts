/**
 * req-96 — the Mission Control shell: the desktop-like iPad with the open
 * state of its panes saved per orientation, and the phone with the menu as
 * its root screen and one labelled back button on every other screen
 * (canvas decisions 12 and 17). Runs the built app against the fake desk
 * in a stock Chromium — `hasTouch` makes Chromium report a coarse pointer
 * without hover, which is how the shell tells an iPad from a desktop
 * browser at the same width. Prerequisite: `npm run build:mission-control`.
 * The screenshots in the test output (1194×834, 834×1194, 390×844) are
 * the evidence the changelog entry names.
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

/** Opens the app paired (the `#token=` landing skips the pairing screen). */
async function openApp(page: Page): Promise<void> {
  await page.goto(`${desk.origin}/#token=e2e-device-token`);
  await expect(page.locator('mc-root .shell')).toBeVisible();
}

const panes = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test.describe('iPad landscape (1194×834)', () => {
  test.use({ viewport: { width: 1194, height: 834 }, hasTouch: true });

  test('opens all three panes, toggles persist under mc.panes.landscape and survive a reload', async ({ page }, testInfo) => {
    await openApp(page);
    const shell = page.locator('.shell.ipad');
    await expect(shell).toBeVisible();
    await expect(page.locator('.topnav')).toHaveCount(0);

    // The header: left toggle, Notes · Work · Crew, Settings, right toggle.
    const header = page.locator('mc-shell-header');
    const left = header.getByRole('button', { name: 'Left sidebar' });
    const right = header.getByRole('button', { name: 'Right sidebar' });
    await expect(left).toHaveAttribute('aria-pressed', 'true');
    await expect(right).toHaveAttribute('aria-pressed', 'true');
    await expect(header.locator('.switch .sw')).toHaveText([/Notes/, /Work/, /Crew/]);
    await expect(header.locator('.switch .sw.on')).toHaveText(/Work/);
    for (const control of [left, right, header.getByRole('button', { name: 'Settings' })]) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect((await header.locator('.hdr').boundingBox())!.height).toBe(52);

    // Left = the Work list, centre = the empty pane, right = Mission Control.
    await expect(page.locator('mc-work.pane-left')).toBeVisible();
    await expect(page.locator('mc-empty.pane-center')).toBeVisible();
    await expect(page.locator('.pane-right mc-chat')).toBeVisible();
    // The right pane switches between Mission Control and Capacity.
    const rightTabs = page.locator('.pad-right [role="tab"]');
    await expect(rightTabs).toHaveText(['Mission Control', 'Capacity']);
    await rightTabs.nth(1).click();
    await expect(page.locator('.pane-right mc-capacity')).toBeVisible();
    await expect(page.locator('mc-chat')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('mc-ipad-capacity.png') });
    await rightTabs.nth(0).click();
    await expect(page.locator('.pane-right mc-chat')).toBeVisible();
    await expect(page.locator('mc-work')).toContainText('Export the board as CSV');
    await page.screenshot({ path: testInfo.outputPath('mc-ipad-landscape.png') });

    // A ticket opens in the centre.
    await page.locator('mc-work').getByText('Export the board as CSV').first().click();
    await expect(page.locator('.ticket-layer.open')).toBeVisible();
    await expect(page.locator('mc-work.pane-left')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mc-ipad-landscape-ticket.png') });

    // Fold the right pane: it leaves, the state lands under the landscape key only.
    await right.click();
    await expect(right).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('mc-chat')).toHaveCount(0);
    expect(await panes(page, 'mc.panes.landscape')).toBe('{"left":true,"right":false}');
    expect(await panes(page, 'mc.panes.portrait')).toBeNull();

    // Fold the left pane too; the centre takes the width.
    await left.click();
    await expect(page.locator('mc-work')).toHaveCount(0);
    expect(await panes(page, 'mc.panes.landscape')).toBe('{"left":false,"right":false}');
    const centre = (await page.locator('.ticket-layer.open').boundingBox())!;
    expect(centre.width).toBeGreaterThan(1100);

    // The state is restored on start.
    await page.reload();
    await expect(page.locator('.shell.ipad')).toBeVisible();
    await expect(page.locator('mc-shell-header').getByRole('button', { name: 'Left sidebar' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('mc-shell-header').getByRole('button', { name: 'Right sidebar' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('mc-work')).toHaveCount(0);
    await expect(page.locator('mc-chat')).toHaveCount(0);

    // Crew in the left pane: the switch opens the pane with the persona list.
    await page.locator('mc-shell-header .sw', { hasText: 'Crew' }).click();
    await expect(page.locator('mc-team.pane-left')).toBeVisible();
    await expect(page.locator('mc-team')).toContainText('Pia');
    await expect(page.locator('mc-shell-header .switch .sw.on')).toHaveText(/Crew/);
    expect(await panes(page, 'mc.panes.landscape')).toBe('{"left":true,"right":false}');

    // Settings owns the centre, and the switch shows no active area meanwhile.
    await page.locator('mc-shell-header').getByRole('button', { name: 'Settings' }).click();
    await expect(page.locator('mc-settings.pane-center')).toBeVisible();
    await expect(page.locator('mc-shell-header .switch .sw.on')).toHaveCount(0);
  });
});

test.describe('iPad portrait (834×1194)', () => {
  test.use({ viewport: { width: 834, height: 1194 }, hasTouch: true });

  test('opens left and centre; the right pane is an overlay and is saved under mc.panes.portrait', async ({ page }, testInfo) => {
    // A landscape state left from before must not leak into portrait.
    await page.addInitScript(() => localStorage.setItem('mc.panes.landscape', '{"left":false,"right":false}'));
    await openApp(page);
    const header = page.locator('mc-shell-header');
    await expect(header.getByRole('button', { name: 'Left sidebar' })).toHaveAttribute('aria-pressed', 'true');
    await expect(header.getByRole('button', { name: 'Right sidebar' })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('mc-work.pane-left')).toBeVisible();
    await expect(page.locator('mc-empty.pane-center')).toBeVisible();
    await expect(page.locator('mc-chat')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('mc-ipad-portrait.png') });

    // The right pane opens as an overlay over the centre, under a scrim.
    await header.getByRole('button', { name: 'Right sidebar' }).click();
    await expect(page.locator('.shell.right-overlay .pane-right mc-chat')).toBeVisible();
    await expect(page.locator('.right-scrim')).toBeVisible();
    await expect(page.locator('mc-work.pane-left')).toBeVisible();
    expect(await panes(page, 'mc.panes.portrait')).toBe('{"left":true,"right":true}');
    expect(await panes(page, 'mc.panes.landscape')).toBe('{"left":false,"right":false}');
    await page.screenshot({ path: testInfo.outputPath('mc-ipad-portrait-chat.png') });

    // The scrim closes it.
    await page.locator('.right-scrim').click({ position: { x: 20, y: 300 } });
    await expect(page.locator('mc-chat')).toHaveCount(0);
    expect(await panes(page, 'mc.panes.portrait')).toBe('{"left":true,"right":false}');
  });
});

test.describe('Phone (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the menu is the root screen: no back button, no hamburger; every other screen has one labelled back button', async ({ page }, testInfo) => {
    await openApp(page);
    const shell = page.locator('.shell.phone');
    await expect(shell).toBeVisible();
    await expect(page.locator('.topnav')).toHaveCount(0);
    await expect(page.locator('mc-shell-header')).toHaveCount(0);

    // The menu: Search, the places, then the chats.
    const menu = page.locator('mc-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('searchbox', { name: 'Search' })).toBeVisible();
    await expect(menu.locator('.places .row')).toHaveText([/Notes/, /Work/, /Crew/, /Settings/]);
    await expect(menu.locator('.places .row', { hasText: 'Work' }).locator('.bdg')).toHaveText('2');
    await expect(menu.locator('.chats .sess')).toHaveText([/Dark mode for the PDF export/, /Why is T-0050 blocked\?/, /Plan the release notes/]);
    await expect(page.locator('button.back:visible')).toHaveCount(0);
    await expect(page.locator('button.menu-btn:visible')).toHaveCount(0);
    for (const row of await menu.locator('.row').all()) {
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(52);
    }
    await page.screenshot({ path: testInfo.outputPath('mc-phone-menu.png') });

    // Work → back "Menu".
    await menu.locator('.places .row', { hasText: 'Work' }).click();
    await expect(page.locator('mc-work')).toBeVisible();
    const backToMenu = page.locator('mc-work mc-app-bar button.back');
    await expect(backToMenu).toBeVisible();
    await expect(backToMenu).toHaveText(/Menu/);
    await expect(backToMenu).toHaveAttribute('aria-label', 'Back to Menu');
    await expect(page.locator('button.menu-btn:visible')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('mc-phone-work.png') });

    // Ticket → back "Work".
    await page.locator('mc-work').getByText('Export the board as CSV').first().click();
    await expect(page.locator('.ticket-layer.open')).toBeVisible();
    const backToWork = page.locator('.ticket-layer mc-ticket mc-app-bar button.back').first();
    await expect(backToWork).toHaveText(/Work/);
    await backToWork.click();
    await expect(page.locator('.ticket-layer.open')).toHaveCount(0);
    await backToMenu.click();
    await expect(menu).toBeVisible();

    // Crew → back "Menu".
    await menu.locator('.places .row', { hasText: 'Crew' }).click();
    await expect(page.locator('mc-team mc-app-bar button.back')).toHaveText(/Menu/);
    await page.locator('mc-team mc-app-bar button.back').click();

    // Settings → back "Menu"; Appearance → back "Settings".
    await menu.locator('.places .row', { hasText: 'Settings' }).click();
    const settings = page.locator('mc-settings');
    await expect(settings.locator('.cats mc-app-bar button.back')).toHaveText(/Menu/);
    await settings.locator('.cats .row', { hasText: 'Appearance' }).click();
    await expect(settings.locator('.page mc-app-bar button.back')).toHaveText(/Settings/);
    await settings.locator('.page mc-app-bar button.back').click();
    await settings.locator('.cats mc-app-bar button.back').click();
    await expect(menu).toBeVisible();

    // A chat → back "Menu"; its own ☰ (history) is not on the phone.
    await menu.locator('.chats .sess', { hasText: 'Dark mode for the PDF export' }).click();
    const chat = page.locator('mc-chat');
    await expect(chat).toBeVisible();
    await expect(chat).toContainText('I can create that ticket.');
    await expect(chat.locator('mc-app-bar button.back')).toHaveText(/Menu/);
    await expect(chat.locator('mc-app-bar button.menu-btn')).toBeHidden();
    await chat.locator('mc-app-bar button.back').click();
    await expect(menu).toBeVisible();
    await expect(menu.locator('.chats .sess.cur')).toHaveText(/Dark mode for the PDF export/);
  });
});

test.describe('Desktop web (1280×800, mouse)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('keeps its top tab bar and the docked chat (G-37)', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.shell.desktop .topnav')).toBeVisible();
    await expect(page.locator('mc-shell-header')).toHaveCount(0);
    await expect(page.locator('mc-menu')).toHaveCount(0);
    await expect(page.locator('.topnav .nt')).toHaveText([/Work/, /Chat/, /Crew/, '']);
    await expect(page.locator('.dock mc-chat')).toBeVisible();
    await expect(page.locator('mc-work.pane-work')).toBeVisible();
  });
});
