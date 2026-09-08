import { test, expect } from './fixtures/drey';

/**
 * ADR-0027: a file dropped on the app chrome (not the editor) must be a
 * no-op, not a navigation to `file://…/that.png`.
 */
test('a file dropped on the titlebar does not navigate the window away', async ({ page }) => {
  await expect(page.locator('app-titlebar')).toBeVisible();
  const urlBefore = page.url();

  await page.evaluate(() => {
    const el = document.querySelector('app-titlebar')!;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));
    for (const name of ['dragover', 'drop'] as const) {
      const event = new DragEvent(name, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: dt });
      el.dispatchEvent(event);
    }
  });

  // Give a navigation a chance to start, then assert the SPA is still up.
  await page.waitForTimeout(300);
  expect(page.url()).toBe(urlBefore);
  await expect(page.locator('app-titlebar .brand .name')).toHaveText('drey');
  await expect(page.locator('app-status-bar')).toBeVisible();
});
