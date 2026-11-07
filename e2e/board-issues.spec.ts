import { test, expect } from './fixtures/drey';

/**
 * Board issues (req-73): the validator's findings about the meta files sit
 * as a chip in the Work panel's header; the chip unfolds the messages,
 * and a message that names a meta file opens it.
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

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': '---\nrepos:\n  drey: {}\n---\nThe work repositories.\n',
    'tickets/10-inbox/T-0001.md': '---\nid: T-0001\ntitle: "First"\npriority: normal\n---\n\n## Description\n',
  },
});

test('the board issues are a header chip that unfolds readable messages', async ({ page }) => {
  await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
  // req-69: the chip sits in the panel header, not a row of their own.
  const controls = page.locator('.tickets-head-view').filter({ visible: true });
  const chip = controls.locator('.tickets-issues-chip');
  // req-73's final shape: icon and count only, the summary in the tooltip.
  await expect(chip).toContainText('2');

  // Contained in the header (T-0086: the head wraps its controls to
  // their own line when narrow — containment is the claim, not one row).
  const head = page.locator('.head', { has: page.locator('.tickets-panel-head') }).filter({ visible: true });
  // While the engine's first board rounds arrive every refresh rebuilds the
  // chip, and `chip.boundingBox()` on a node already replaced answers null:
  // one synchronous read over the header, which stays, measures one state.
  const boxes = await head.evaluate((el) => {
    const measured = el.querySelector('.tickets-issues-chip')?.getBoundingClientRect();
    const own = el.getBoundingClientRect();
    return { head: { y: own.y, height: own.height }, chip: measured === undefined ? null : { y: measured.y, height: measured.height } };
  });
  expect(boxes.chip).not.toBeNull();
  const chipBox = boxes.chip!;
  const headBox = boxes.head;
  expect(chipBox.height).toBeGreaterThan(0);
  expect(chipBox.y).toBeGreaterThanOrEqual(headBox.y);
  expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(headBox.y + headBox.height);
  await page.screenshot({ path: test.info().outputPath('board-issues-folded.png') });

  await chip.click();
  const items = page.locator('.tickets-issues-item').filter({ visible: true });
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: 'pipeline.md: push must be a remote name string' })).toHaveCount(1);
  const reposIssue = items.filter({ hasText: 'repos.md: repo "drey" needs a url' });
  await expect(reposIssue).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('board-issues-open.png') });

  await reposIssue.locator('.tickets-issues-open').click();
  await expect(page.locator('app-editor .cm-content')).toContainText('The work repositories.');

  await chip.click();
  await expect(items).toHaveCount(0);
});
