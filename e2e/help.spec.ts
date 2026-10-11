import { test, expect } from './fixtures/drey';

/**
 * The in-app help documents (ADR-0070): the Help menu opens the bundled
 * user manual and the generated keyboard shortcuts list as read-only,
 * pinned editor tabs, and "About Drey" deep-links Settings to its About
 * category.
 */

test.describe('Help menu (ADR-0070)', () => {
  test('User manual opens as a read-only pinned tab and renders its screenshots', async ({
    page,
  }) => {
    await page.locator('app-titlebar .menu-label', { hasText: 'Help' }).click();
    await page.locator('app-titlebar .popover .row', { hasText: 'User manual' }).click();

    const tab = page.locator('app-tab-bar .tab', { hasText: 'User manual' });
    await expect(tab).toBeVisible();
    await expect(tab.locator('.pin')).toBeVisible();

    // Read-only: the surface is non-editable in 'view' mode.
    const content = page.locator('app-editor .cm-content');
    await expect(content).toBeVisible();
    await expect(content).toHaveAttribute('contenteditable', 'false');

    // CodeMirror renders image widgets per viewport -- walk the document
    // until one of the manual's screenshots has mounted, then require it
    // to actually load from the app origin (the help asset base, not
    // drey-asset://).
    const scroller = page.locator('app-editor .cm-scroller');
    const shot = content.locator('img[src^="manual/img/"]').first();
    for (let step = 0; step < 24 && !(await shot.isVisible()); step++) {
      await scroller.evaluate((el, i) => {
        el.scrollTop = (i + 1) * el.clientHeight * 0.8;
      }, step);
      await page.waitForTimeout(120);
    }
    await expect(shot).toBeVisible();
    expect(await shot.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });

  test('F1 opens the manual without the menu', async ({ page }) => {
    await page.keyboard.press('F1');
    await expect(page.locator('app-tab-bar .tab', { hasText: 'User manual' })).toBeVisible();
  });

  test('Keyboard shortcuts lists the live command registry', async ({ page }) => {
    await page.locator('app-titlebar .menu-label', { hasText: 'Help' }).click();
    await page.locator('app-titlebar .popover .row', { hasText: 'Keyboard shortcuts' }).click();

    const content = page.locator('app-editor .cm-content');
    // The '# ' heading marker is concealed in the rendered view mode.
    await expect(content).toContainText('Keyboard shortcuts');
    // A base command with its chord, straight from the registry.
    await expect(content).toContainText('Go to file');
    await expect(content).toContainText('Ctrl P');
    // The fixed editing rows ride along.
    await expect(content).toContainText('Find in note');
    await expect(content).toHaveAttribute('contenteditable', 'false');
  });

  test('About Drey opens Settings on the About category', async ({ page }) => {
    await page.locator('app-titlebar .menu-label', { hasText: 'Help' }).click();
    await page.locator('app-titlebar .popover .row', { hasText: 'About Drey' }).click();

    // The overlay's children are position:fixed -- wait on the panel, not
    // the zero-sized host element.
    await expect(page.locator('app-settings .panel')).toBeVisible();
    await expect(page.locator('app-settings .category.active')).toHaveText(/About/);
  });
});
