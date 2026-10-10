import { test, expect, type Page } from './fixtures/drey';

/**
 * The task-line metadata completion AND click-to-change (req-37): typing
 * the trigger on a checkbox line opens the completion (date options incl.
 * the date-picker entry, priority glyphs); a plain click on a token chip —
 * in the editor or as a Tasks-panel badge — re-opens the matching picker
 * and the change is written back. The scanner/filter logic has unit
 * specs; this spec pins the seams end to end.
 */

const NOTE = ['---', 'title: Meta demo', '---', '', '- [ ] draft the brief', ''].join('\n');

const TOKENS = [
  '---',
  'title: Token demo',
  '---',
  '',
  '- [ ] water the orchids 📅 2026-01-01 ⏫',
  '',
].join('\n');

test.use({ seedVault: { 'meta-demo.md': NOTE, 'meta-tokens.md': TOKENS } });

/** Opens the note and parks the cursor at the end of the checkbox line. */
async function focusTaskLineEnd(page: Page, file: string): Promise<void> {
  await page.locator('app-dock[side="left"] .node.file', { hasText: file }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
  await page
    .locator('app-editor .cm-content .cm-line', { hasText: 'draft the brief' })
    .click();
  await page.keyboard.press('End');
}

test.describe('task metadata completion', () => {
  test('typing `due` on a checkbox line opens the date completion', async ({ page }) => {
    await focusTaskLineEnd(page, 'meta-demo.md');
    await page.keyboard.type(' due');
    const popup = page.locator('.cm-tooltip.cm-tooltip-autocomplete');
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toContainText('Today');
    await expect(popup).toContainText('Pick a date…');
  });

  test('typing `prio` on a checkbox line opens the priority completion', async ({ page }) => {
    await focusTaskLineEnd(page, 'meta-demo.md');
    await page.keyboard.type(' prio');
    const popup = page.locator('.cm-tooltip.cm-tooltip-autocomplete');
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toContainText('Highest');
    await expect(popup).toContainText('High');
    await expect(popup).toContainText('Low');
  });

  test('accepting a date option writes the 📅 token over the trigger word', async ({ page }) => {
    await focusTaskLineEnd(page, 'meta-demo.md');
    await page.keyboard.type(' due');
    const popup = page.locator('.cm-tooltip.cm-tooltip-autocomplete');
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await popup.getByText('Today').click();
    const line = page.locator('app-editor .cm-content .cm-line', {
      hasText: 'draft the brief',
    });
    await expect(line).toContainText('📅');
    await expect(line).not.toContainText('due');
  });
});

test.describe('task metadata click-to-change', () => {
  test('a plain click on the editor chip re-opens the date picker and applies', async ({
    page,
  }) => {
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'meta-tokens.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();

    await page.locator('app-editor .cm-content .cm-task-due').click();
    const picker = page.locator('.tasks-due-picker');
    await expect(picker).toBeVisible();
    await expect(picker.locator('input[type="date"]')).toHaveValue('2026-01-01');
    await picker.locator('input[type="date"]').fill('2026-03-03');
    await picker.locator('button.apply').click();

    const line = page.locator('app-editor .cm-content .cm-line', {
      hasText: 'water the orchids',
    });
    await expect(line).toContainText('📅 2026-03-03');
    await expect(line).not.toContainText('2026-01-01');
  });

  test('a plain click on the editor glyph opens the priority menu and applies', async ({
    page,
  }) => {
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'meta-tokens.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();

    await page.locator('app-editor .cm-content .cm-task-prio').click();
    const menu = page.locator('.tasks-prio-picker');
    await expect(menu).toBeVisible();
    await menu.getByText('Low').click();

    const line = page.locator('app-editor .cm-content .cm-line', {
      hasText: 'water the orchids',
    });
    await expect(line).toContainText('🔽');
    await expect(line).not.toContainText('⏫');
  });

  test('a click behind the line-ending token places the caret, no picker', async ({ page }) => {
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'meta-tokens.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();

    // Click in the empty space right of the trailing ⏫ (the line's last
    // element): no picker may open, and the caret must sit BEHIND the
    // token -- proven by the next typed char landing after it.
    const line = page.locator('app-editor .cm-content .cm-line', {
      hasText: 'water the orchids',
    });
    const box = (await line.boundingBox())!;
    await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
    await expect(page.locator('.tasks-picker')).toHaveCount(0);
    await expect(page.locator('.cm-tooltip-autocomplete')).toHaveCount(0);
    await page.keyboard.type('!');
    await expect(line).toHaveText(/⏫!$/);
  });

  test('the Tasks panel badge re-opens the picker and the change reaches disk', async ({
    page,
  }) => {
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'meta-tokens.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toBeVisible();
    await page.locator('app-panel-frame .head[aria-label="Collapse Calendar"]').click();
    await page.locator('app-panel-frame .head[aria-label="Expand Tasks"]').click();
    const panel = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    const row = panel.locator('.task', { hasText: 'water the orchids' });
    await expect(row).toBeVisible();

    await row.locator('.due').click();
    const picker = page.locator('.tasks-due-picker');
    await expect(picker).toBeVisible();
    await picker.locator('input[type="date"]').fill('2026-04-04');
    await picker.locator('button.apply').click();

    // The open buffer was patched + saved; the panel list follows.
    await expect(row.locator('.due')).toHaveText('📅 2026-04-04');

    // And it is on disk: after a reload the badge still shows the new date.
    await page.reload();
    const reloaded = page.locator('app-panel-frame', { has: page.locator('.tasks-panel') });
    await expect(
      reloaded.locator('.task', { hasText: 'water the orchids' }).locator('.due'),
    ).toHaveText('📅 2026-04-04');
  });
});
