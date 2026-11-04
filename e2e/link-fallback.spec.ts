import { test, expect } from './fixtures/drey';

/**
 * E13-4: a `[[link]]` that matches nothing in its own vault resolves into
 * another registered vault -- but only when the link's vault opted in
 * (Settings → Vault, default off). Off: Ctrl-click still creates the note.
 */

const NOTE = ['# Start', '', 'See [[T-0063]] and [[Shared plan]].', ''].join('\n');
const TICKET = ['# T-0063', '', 'The ticket text.', ''].join('\n');

test.use({
  seedVault: { 'start.md': NOTE },
  extraVaults: {
    tickets: { 'tickets/T-0063.md': TICKET },
    archive: { 'old/T-0063.md': '# old copy\n', 'Shared plan.md': '# plan in archive\n' },
  },
});

test('a link resolves into a second vault once the vault opted in, naming the vault on hover', async ({
  page,
}) => {
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'start.md' }).click();
  const link = page.locator('app-editor .cm-wikilink', { hasText: 'T-0063' }).first();

  // Default off: the link is unresolved.
  await expect(link).toHaveClass(/cm-wikilink-unresolved/);

  // Settings → Vault → switch on for the "main" vault.
  await page.locator('app-status-bar').getByRole('button', { name: /settings/i }).click();
  await page.getByText('Vault', { exact: true }).first().click();
  await page
    .locator('label.switch-row', { hasText: 'Also look for link targets in other vaults (main)' })
    .locator('input')
    .check();
  await page.locator('app-settings .close').click();

  // Repaint the marks: an edit rebuilds the decorations.
  await page.locator('app-editor .cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' ');

  const resolved = page.locator('app-editor .cm-wikilink', { hasText: 'T-0063' }).first();
  await expect(resolved).not.toHaveClass(/cm-wikilink-unresolved/);
  await expect(resolved).toHaveClass(/cm-wikilink-ambiguous/);
  await expect(resolved).toHaveAttribute('title', /Ambiguous: also in “archive”.*“tickets”/);

  const plan = page.locator('app-editor .cm-wikilink', { hasText: 'Shared plan' }).first();
  await expect(plan).toHaveAttribute('title', 'In vault “archive”');

  // Ctrl-click opens the note of the OTHER vault; nothing is created in "main".
  await resolved.click({ modifiers: ['Control'] });
  await expect(page.locator('app-editor .cm-content')).toContainText('The ticket text.');
  await expect(page.locator('app-tab-bar .tab', { hasText: 'T-0063' })).toBeVisible();
});
