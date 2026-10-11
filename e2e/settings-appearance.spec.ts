import { test, expect, type Page } from './fixtures/drey';

/**
 * ADR-0020 "Later change": the Appearance category uses the shared draft /
 * Save / Discard flow like every other category -- changes preview live
 * but reach disk only on Save, and Discard rolls the preview back.
 */
const accentVar = (page: Page): Promise<string> =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase(),
  );

async function openAppearance(page: Page): Promise<void> {
  await page.locator('app-status-bar .settings').click();
  await page.locator('app-settings .category', { hasText: 'Appearance' }).click();
  await expect(page.locator('app-settings-appearance')).toBeVisible();
}

test('Appearance: live preview, Save to commit, Discard reverts', async ({ page }) => {
  await openAppearance(page);

  expect(await accentVar(page)).toBe('#8ecbef'); // default = Anthrazit's seed accent
  await expect(page.locator('app-settings .actions-bar .saved')).toBeVisible();
  await expect(page.locator('app-settings .actions-bar button.primary')).toBeDisabled();

  // Pick "Sage" -> previews immediately, dirties the draft, enables Save.
  await page.locator('app-settings .swatch[title="Sage"]').click();
  await expect.poll(() => accentVar(page)).toBe('#7d8f6e');
  await expect(page.locator('app-settings .actions-bar .dirty')).toBeVisible();
  await expect(page.locator('app-settings .actions-bar button.primary')).toBeEnabled();

  // Discard from the footer -> unsaved-changes bar -> Discard -> preview rolls back.
  await page.locator('app-settings .actions-bar button.ghost', { hasText: 'Discard' }).click();
  await page.locator('app-settings .unsaved button.danger', { hasText: 'Discard' }).click();
  await expect(page.locator('app-settings')).toHaveCount(0);
  await expect.poll(() => accentVar(page)).toBe('#8ecbef');

  // Reopen: default is back, nothing was persisted. The default accent is
  // the "match the theme" sentinel (ADR-0035), which for the Anthrazit
  // theme resolves to its seed blue.
  await openAppearance(page);
  await expect(page.locator('app-settings .swatch[title="Match the theme"]')).toHaveClass(/active/);

  // Change again and Save from the footer -> persists, footer goes clean.
  await page.locator('app-settings .swatch[title="Sage"]').click();
  await page.locator('app-settings .actions-bar button.primary').click();
  await expect(page.locator('app-settings .actions-bar .saved')).toBeVisible();
  await page.locator('app-settings .close').click();
  await expect(page.locator('app-settings')).toHaveCount(0);
  expect(await accentVar(page)).toBe('#7d8f6e');

  // And it sticks on the next open.
  await openAppearance(page);
  await expect(page.locator('app-settings .swatch[title="Sage"]')).toHaveClass(/active/);
});

/**
 * ADR-0035: the theme picker swaps the editor's CodeMirror theme and
 * re-tints the shell from a per-theme seed (`data-theme` + `--_bg`/`--_fg`
 * on <html>). Drey carries no attribute; the default is Anthrazit.
 */
test('Appearance: theme picker re-tints the shell and persists', async ({ page }) => {
  const dataTheme = (): Promise<string | null> =>
    page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const seedBg = (): Promise<string> =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--_bg').trim(),
    );

  await openAppearance(page);
  expect(await dataTheme()).toBe('anthrazit'); // the fresh-install default

  await page.locator('app-settings-appearance select#app-theme').selectOption('nord');
  await expect.poll(dataTheme).toBe('nord');
  expect(await seedBg()).toBe('#2e3440'); // Nord's seed background

  await page.locator('app-settings .actions-bar button.primary').click();
  await page.locator('app-settings .close').click();
  await expect(page.locator('app-settings')).toHaveCount(0);
  expect(await dataTheme()).toBe('nord'); // stuck after Save

  // Cyberpunk is a bespoke palette: exact tokens, and its seed pink as accent.
  await openAppearance(page);
  await page.locator('app-settings-appearance select#app-theme').selectOption('cyberpunk');
  await expect.poll(dataTheme).toBe('cyberpunk');
  await expect.poll(() => accentVar(page)).toBe('#ff4fa8');
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-editor').trim(),
    ),
  ).toBe('#0e0b1a');

  await page.locator('app-settings-appearance select#app-theme').selectOption('drey');
  await page.locator('app-settings .actions-bar button.primary').click();
  await expect.poll(dataTheme).toBeNull(); // Drey clears the attribute
});
