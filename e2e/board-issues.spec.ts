import { test, expect } from './fixtures/drey';

/**
 * Board issues (req-66): the validator's findings about the meta files sit
 * as a chip in the board toolbar beside the filter; the chip unfolds the
 * messages, and a message that names a meta file opens it.
 */

const PIPELINE = [
  '---',
  'push: 42',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  '',
].join('\n');

const ORDER = ['# Column order pins', '', '## qa', '', '- T-0001', ''].join('\n');

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': '---\nrepos: {}\n---\n',
    'tickets/_meta/order.md': ORDER,
    'tickets/10-inbox/T-0001.md': '---\nid: T-0001\ntitle: "First"\npriority: normal\n---\n\n## Description\n',
  },
});

test('the board issues are a header chip that unfolds readable messages', async ({ page }) => {
  await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
  // req-69: filter and chip sit in the panel header, not a row of their own.
  const controls = page.locator('.tickets-head-view').filter({ visible: true });
  const chip = controls.locator('.tickets-issues-chip');
  // req-66's final shape: icon and count only, the summary in the tooltip.
  await expect(chip).toContainText('2');
  const filter = controls.locator('.tickets-filter-btn');
  await expect(filter).toHaveCount(1);

  // One line: the header's title and the controls share a row.
  // Centred on it, too: the editor's `.tickets-head` rule once leaked in here.
  const title = page.locator('.head', { has: page.locator('.tickets-panel-head') }).locator('.title');
  const titleBox = (await title.boundingBox())!;
  const filterBox = (await filter.boundingBox())!;
  expect(Math.abs(titleBox.y + titleBox.height / 2 - (filterBox.y + filterBox.height / 2))).toBeLessThan(2);
  await page.screenshot({ path: test.info().outputPath('board-issues-folded.png') });

  await chip.click();
  const items = page.locator('.tickets-issues-item').filter({ visible: true });
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('pipeline.md: push must be a remote name string');
  await expect(items.nth(1)).toContainText('order.md pins unknown phase "qa"');
  await page.screenshot({ path: test.info().outputPath('board-issues-open.png') });

  await items.nth(1).locator('.tickets-issues-open').click();
  await expect(page.locator('app-editor .cm-content')).toContainText('Column order pins');

  await chip.click();
  await expect(items).toHaveCount(0);
});
