import { test, expect } from './fixtures/drey';

/**
 * The Backlinks plugin (milestone 54): the panel follows the focused note
 * and lists every note whose `[[wikilink]]` resolves to it; a row click
 * opens the linking note at the line. The index builds in the background
 * after plugin activation — assertions poll until the boot sweep landed.
 */

const HUB = [
  '# Hub',
  '',
  '## Reference',
  '',
  'See [[spoke]] for details, and [[spoke#Part two]] too.',
  '',
].join('\n');

const SPOKE = ['# Spoke', '', 'Nothing linking here.', '', '## Part two', '', 'Body.', ''].join(
  '\n',
);

test.use({ seedVault: { 'hub.md': HUB, 'spoke.md': SPOKE } });

test.describe('Backlinks panel (plugins/backlinks, milestone 54)', () => {
  test('lists the linking notes of the focused note and opens them at the line', async ({
    page,
  }) => {
    // The panel lands collapsed at the bottom of the left dock.
    await page.locator('app-panel-frame .head[aria-label="Expand Backlinks"]').click();
    const panel = page.locator('app-panel-frame', { has: page.locator('.backlinks-panel') });

    // Focus the linked note through the Files panel.
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'spoke.md' }).click();
    await expect(page.locator('app-editor .cm-content')).toContainText('Nothing linking here.');

    // Two links in hub.md resolve to spoke.md — one row per occurrence.
    const rows = panel.locator('.backlinks-panel .row');
    await expect(rows).toHaveCount(2, { timeout: 10_000 });
    await expect(rows.first().locator('.file')).toHaveText('hub');
    await expect(rows.first().locator('.heading')).toHaveText('Reference');

    // A row click opens the linking note (the focused pane's clean tab is
    // replaced); Live Preview conceals the brackets, so the rendered link
    // text is the check.
    await rows.first().click();
    await expect(page.locator('app-editor .cm-content')).toContainText('See spoke for details');

    // A note nobody links to shows the empty state.
    await page.locator('app-dock[side="left"] .node.file', { hasText: 'hub.md' }).click();
    await expect(panel.locator('.backlinks-panel .empty')).toHaveText('No backlinks.');
  });
});
