import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/** A 1x1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFhAJ/wlseKgAAAABJRU5ErkJggg==';

async function openNoteWithImage(page: Page, vaultDir: string): Promise<void> {
  fs.mkdirSync(path.join(vaultDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'assets', 'p.png'), Buffer.from(PNG_BASE64, 'base64'));
  fs.writeFileSync(path.join(vaultDir, 'has-image.md'), '# pic\n\n![a shot](assets/p.png)\n');
  await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'has-image.md' }).click();
  await expect(page.locator('app-editor .cm-content .lp-image img')).toBeVisible();
}

test.describe('image lens → fullscreen viewer', () => {
  test('the hover lens opens the full-app viewer; Escape and backdrop close it', async ({
    page,
    vaultDir,
  }) => {
    await openNoteWithImage(page, vaultDir);

    const lens = page.locator('app-editor .cm-content .lp-image .lp-lens');
    await page.locator('app-editor .cm-content .lp-image').hover();
    await expect(lens).toBeVisible();
    await lens.click();

    const backdrop = page.locator('app-image-lightbox .backdrop');
    await expect(backdrop).toBeVisible();
    await expect(page.locator('app-image-lightbox app-image-viewer img')).toHaveAttribute(
      'src',
      /^drey-asset:\/\/asset\/assets\/p\.png$/,
    );
    // Sits above every other overlay.
    expect(await backdrop.evaluate((el) => getComputedStyle(el).zIndex)).toBe('60');

    await page.keyboard.press('Escape');
    await expect(backdrop).toHaveCount(0);

    // Reopen, then dismiss by clicking empty space in the viewer.
    await page.locator('app-editor .cm-content .lp-image').hover();
    await lens.click();
    await expect(backdrop).toBeVisible();
    await page.locator('app-image-lightbox .stage').click({ position: { x: 5, y: 5 } });
    await expect(backdrop).toHaveCount(0);
  });

  test('wheel over the viewer zooms it', async ({ page, vaultDir }) => {
    await openNoteWithImage(page, vaultDir);
    await page.locator('app-editor .cm-content .lp-image').hover();
    await page.locator('app-editor .cm-content .lp-image .lp-lens').click();

    const pct = page.locator('app-image-lightbox .zoom-cluster .pct');
    await expect(pct).toHaveText('100%');
    await page.locator('app-image-lightbox .stage').hover();
    await page.mouse.wheel(0, -600);
    await expect(pct).not.toHaveText('100%');
  });
});
