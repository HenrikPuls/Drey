import { test, expect, type Page } from './fixtures/drey';

/**
 * ADR-0010 "Later change": Settings has no Save and no Discard. A change
 * applies as it is made and saves itself a moment later; the footer shows
 * the save status and one Close button.
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

const footer = (page: Page) => page.locator('app-settings .actions-bar');

/** The stored config, read back over IPC -- what a restart would start on. */
const storedConfig = (page: Page): Promise<{ appearance: { accent: string }; daily: { dir: string } }> =>
  page.evaluate(() => window.dreyApi.getConfig());

test('Appearance: a change applies at once, saves itself and survives closing', async ({ page }) => {
  await openAppearance(page);

  expect(await accentVar(page)).toBe('#8ecbef'); // default = Anthrazit's seed accent
  await expect(footer(page).locator('.saved')).toHaveText('Changes are saved automatically');
  // One button, and it closes: no Save, no Discard.
  await expect(footer(page).locator('button')).toHaveCount(1);
  await expect(footer(page).locator('button')).toHaveText('Close');

  // Pick "Sage" -> shows immediately and reaches disk without a Save click.
  await page.locator('app-settings .swatch[title="Sage"]').click();
  await expect.poll(() => accentVar(page)).toBe('#7d8f6e');
  await expect.poll(async () => (await storedConfig(page)).appearance.accent).toBe('sage');
  await expect(footer(page).locator('.saved')).toHaveText('Changes are saved automatically');

  await footer(page).locator('button', { hasText: 'Close' }).click();
  await expect(page.locator('app-settings')).toHaveCount(0);
  expect(await accentVar(page)).toBe('#7d8f6e');

  // And it sticks on the next open.
  await openAppearance(page);
  await expect(page.locator('app-settings .swatch[title="Sage"]')).toHaveClass(/active/);
});

test('Settings: a typed value is stored when the field is left, not per keystroke', async ({
  page,
}) => {
  await page.locator('app-status-bar .settings').click();
  await page.locator('app-settings .category', { hasText: 'Daily notes' }).click();
  const dir = page.locator('app-settings-daily input[type="text"]');

  await dir.fill('Jour');
  await page.waitForTimeout(900); // well past the automatic-save delay
  expect((await storedConfig(page)).daily.dir).toBe('daily'); // half-typed: not stored

  await dir.fill('Journal');
  await dir.press('Enter');
  await expect.poll(async () => (await storedConfig(page)).daily.dir).toBe('Journal');

  // Closing stores what is still in a focused field.
  await dir.fill('Diary');
  await page.keyboard.press('Escape');
  await expect(page.locator('app-settings')).toHaveCount(0);
  expect((await storedConfig(page)).daily.dir).toBe('Diary');
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

  await page.locator('app-settings .close').click();
  await expect(page.locator('app-settings')).toHaveCount(0);
  expect(await dataTheme()).toBe('nord'); // stuck after closing

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
  await expect.poll(dataTheme).toBeNull(); // Drey clears the attribute
});
