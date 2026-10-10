import { test, expect, type Page } from './fixtures/drey';

/**
 * Caret + scroll restore across a tab switch (milestone 50). On leave a
 * tab remembers its viewport (caret head + scroll offset + the caret's
 * viewport-relative position); on re-entry both are restored -- exactly.
 * This spec exists because the unit suite runs in jsdom (no real layout,
 * no browser focus-scroll): production showed the browser scrolling the
 * freshly focused editor TO THE CARET after the raw restore, silently
 * overriding the remembered scroll offset. The restore chain re-asserts
 * the stored offset after that interference (frame 2), so a viewport
 * that does NOT contain the caret is the discriminating scenario here.
 * The save test covers the in-place reload sibling: every save of a
 * frontmattered note bumps `updated:`, the renderer adopts the rewritten
 * text and reloads the SAME tab -- the full replace used to collapse the
 * height map and drop the view at the top.
 */

const LINES = 160;

/** Long enough that a viewport deep in the note is a stable scroll target. */
const LONG = `# Long note\n\n${Array.from({ length: LINES }, (_, i) => `Line ${i} of the long note.`).join('\n')}\n`;
const OTHER = '# Other\n\nshort body\n';
/** Frontmattered twin of LONG: a save rewrites the fence (the `updated:` bump). */
const SAVED = `---\ntitle: Save me\nupdated: "2026-01-01T00:00:00"\n---\n\n# Save note\n\n${Array.from({ length: LINES }, (_, i) => `Line ${i} of the save note.`).join('\n')}\n`;

test.use({ seedVault: { 'long.md': LONG, 'other.md': OTHER, 'saved.md': SAVED } });

const scrollTop = (page: Page): Promise<number> =>
  page.evaluate(
    () => (document.querySelector('app-editor .cm-scroller') as HTMLElement).scrollTop,
  );

const editorHasFocus = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.activeElement?.closest('.cm-content') != null);

async function openFile(page: Page, name: string): Promise<void> {
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).click();
}

/** Sets the editor scroll offset and lets CodeMirror render the viewport. */
async function scrollTo(page: Page, value: number): Promise<void> {
  await page.evaluate((top) => {
    (document.querySelector('app-editor .cm-scroller') as HTMLElement).scrollTop = top;
  }, value);
  await page.waitForTimeout(120);
}

test.describe('caret + scroll restore (milestone 50)', () => {
  test('switching back restores the remembered viewport, not the caret', async ({ page }) => {
    await openFile(page, 'long.md');
    await expect(page.locator('app-editor .cm-content')).toContainText('Line 5 of the long note');

    // Caret deep in the note (CodeMirror only renders the viewport, so
    // scroll there first to make the line clickable), then the viewport
    // scrolled far AWAY from it -- the caret ends up off-screen: the
    // anchor-less restore path, and exactly the situation where a
    // scroll-to-caret interference shows.
    await scrollTo(page, 2_400);
    await page.locator('.cm-line', { hasText: 'Line 100 of the long note' }).click();
    await page.keyboard.type('x'); // dirty, so the next file opens alongside
    await expect(page.locator('app-editor .dirty')).toBeVisible();
    const setTo = 600;
    await scrollTo(page, setTo);

    await openFile(page, 'other.md');
    await expect(page.locator('app-editor .cm-content')).toContainText('short body');
    await expect.poll(() => scrollTop(page)).toBeLessThan(setTo); // near the top

    await page.locator('app-tab-bar .tab', { hasText: 'long.md' }).click();
    // The restore chain runs in animation frames (raw apply, re-assert,
    // optional caret-anchored correction) -- let them settle.
    await page.waitForTimeout(300);

    const restored = await scrollTop(page);
    expect(restored).toBeGreaterThan(setTo - 80); // ~2 lines of drift tolerance
    expect(restored).toBeLessThan(setTo + 80);
    // Entering a tab focuses the editor: typing lands without a click.
    expect(await editorHasFocus(page)).toBe(true);
  });

  test('switching back twice keeps restoring the same viewport', async ({ page }) => {
    await openFile(page, 'long.md');
    // Wait for the load to settle BEFORE scrolling -- `openFile` resolves
    // when the doc record lands; the editor swap (and its show-the-top
    // reset) can still be one change-detection behind and would zero a
    // too-early scroll (the same wait every other test here does).
    await expect(page.locator('app-editor .cm-content')).toContainText('Line 5 of the long note.');
    await scrollTo(page, 2_700);
    await page.locator('.cm-line', { hasText: 'Line 120 of the long note' }).click();
    await page.keyboard.type('x');
    const setTo = 900;
    await scrollTo(page, setTo);
    await openFile(page, 'other.md');
    await expect(page.locator('app-editor .cm-content')).toContainText('short body');

    for (let round = 0; round < 2; round++) {
      await page.locator('app-tab-bar .tab', { hasText: 'long.md' }).click();
      await page.waitForTimeout(300);
      await expect
        .poll(() => scrollTop(page), { timeout: 2_000 })
        .toBeGreaterThan(setTo - 80);
      expect(await scrollTop(page)).toBeLessThan(setTo + 80);
      await page.locator('app-tab-bar .tab', { hasText: 'other.md' }).click();
      await expect(page.locator('app-editor .cm-content')).toContainText('short body');
    }
  });

  test('scroll-only browsing (caret untouched) survives a replace + reopen', async ({ page }) => {
    await openFile(page, 'long.md');
    await expect(page.locator('app-editor .cm-content')).toContainText('Line 5 of the long note');

    // Only scroll -- the caret never leaves offset 0, and the note stays
    // clean. Opening other.md then REPLACES the tab (milestone 32): the
    // remembered viewport must survive the close/reopen cycle even with
    // the caret at 0 (the case the anchor>0 gate used to drop).
    const setTo = 600;
    await scrollTo(page, setTo);
    await openFile(page, 'other.md');
    await expect(page.locator('app-editor .cm-content')).toContainText('short body');
    await openFile(page, 'long.md'); // reopen from the files panel
    await expect(page.locator('app-editor .cm-content')).toContainText('Line 5 of the long note');
    await page.waitForTimeout(300);

    const restored = await scrollTop(page);
    expect(restored).toBeGreaterThan(setTo - 80);
    expect(restored).toBeLessThan(setTo + 80);
  });

  test('saving keeps the viewport (the frontmatter bump reloads the same tab)', async ({ page }) => {
    await openFile(page, 'saved.md');
    await expect(page.locator('app-editor .cm-content')).toContainText('Line 5 of the save note.');
    const setTo = 600;
    await scrollTo(page, setTo);
    // Dirty the note inside the scrolled viewport, then save. The pipeline
    // bumps the note's existing `updated:`, the renderer adopts the
    // rewritten text, and the effect reloads the SAME tab in place -- the
    // resulting full replace must not cost the user their viewport.
    await page.locator('.cm-line', { hasText: 'Line 30 of the save note.' }).click();
    await page.keyboard.type('x');
    await expect(page.locator('app-editor .dirty')).toBeVisible();
    await page.keyboard.press('Control+S');
    await expect(page.locator('app-editor .dirty')).toBeHidden({ timeout: 5_000 });
    await page.waitForTimeout(400); // the adoption effect + the restore frames

    const restored = await scrollTop(page);
    expect(restored).toBeGreaterThan(setTo - 80);
    expect(restored).toBeLessThan(setTo + 80);
  });
});
