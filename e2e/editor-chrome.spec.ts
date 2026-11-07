import { test, expect } from './fixtures/drey';

/**
 * The editor meta bar's right cluster (roadmap "Editor chrome"): dirty
 * state shows in the save button alone -- no spelled-out word -- and the
 * zoom indicator (Ctrl +/-/0, Ctrl+wheel) appears only away from 100%;
 * one click resets it.
 */

test.use({ seedVault: { 'note.md': '# Note\n\nSome body text.\n' } });

test.describe('Editor meta bar chrome', () => {
  test('dirty shows in the Save pill alone; the zoom chip appears and resets', async ({
    page,
  }) => {
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'note.md' }).click();
    const chrome = page.locator('app-editor .chrome');
    const save = page.locator('app-editor .actions .save');

    // Clean document: no Save pill, no zoom chip, no spelled-out word.
    await expect(save).toHaveCount(0);
    await expect(chrome.locator('.zoom-chip')).toHaveCount(0);
    expect((await chrome.textContent()) ?? '').not.toMatch(/unsaved/i);

    // Type: the Save pill alone carries the dirty state.
    await page.locator('app-editor .cm-content').click();
    await page.keyboard.type('more text ');
    await expect(save).toBeVisible();
    expect((await chrome.textContent()) ?? '').not.toMatch(/unsaved/i);

    // One zoom step in: the chip appears with the percentage...
    await page.keyboard.press('Control+=');
    const chip = chrome.locator('.zoom-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('110%');

    // ...and clicking it resets to 100%, which hides it again.
    await chip.click();
    await expect(chip).toHaveCount(0);
  });
});
