import { test, expect } from './fixtures/drey';

/**
 * The interactive dialog's affordances (req-65, req-72): "Plan with agent"
 * on the first automatic column and "Refine with agent" in every manual
 * column — in the ticket header and the card menu. The run itself (worker,
 * takeover tab, end moves) is the owner's live round; here the switches
 * must simply be where the rules put them, and nowhere else.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default }',
  '  - { id: plan-review, title: Plan review, handover: manual }',
  '  - { id: build, title: Build, handover: agent build-default }',
  '  - { id: review, title: Review, handover: manual }',
  '  - { id: commit, title: Commit, handover: agent commit-default }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

function ticket(id: string, title: string, phase: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    'repo: drey',
    'priority: normal',
    'rank: 5000',
    `branch: t/${id}`,
    `entered-inbox: '2026-10-17T14:32:00Z'`,
    `entered-${phase}: '2026-10-18T09:00:00Z'`,
    '---',
    '',
    '## Description',
    '',
    'It should work.',
    '',
    '## Log',
    '',
  ].join('\n');
}

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/_meta/order.md': '# Column order pins\n',
    'tickets/20-plan/T-0042.md': ticket('T-0042', 'Plan me', 'plan'),
    'tickets/30-plan-review/T-0043.md': ticket('T-0043', 'Review me', 'plan-review'),
    'tickets/40-build/T-0044.md': ticket('T-0044', 'Build me', 'build'),
    'plain.md': '---\ntitle: "A plain note"\n---\n\n# Plain\n',
  },
});
test.describe('Interactive dialog affordances (req-65)', () => {
  test('the header offers the dialog exactly where the column does', async ({ page }) => {
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();

    // Plan column: the plan dialog.
    await page.locator('.tickets-card[data-id="T-0042"]').filter({ visible: true }).click();
    const head = page.locator('app-editor .tickets-head');
    await expect(head).toBeVisible({ timeout: 15_000 });
    await expect(head.locator('.tickets-head-dialog')).toHaveText('Plan with agent');

    // The checkpoint: the refine dialog.
    await page.locator('.tickets-card[data-id="T-0043"]').filter({ visible: true }).click();
    await expect(page.locator('app-editor .tickets-head')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('app-editor .tickets-head .tickets-head-dialog')).toHaveText('Refine with agent');

    // A middle agent column (build) offers none — and neither does a plain note.
    await page.locator('.tickets-card[data-id="T-0044"]').filter({ visible: true }).click();
    await expect(page.locator('app-editor .tickets-head')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('app-editor .tickets-head .tickets-head-dialog')).toHaveCount(0);
  });

  test('the card menu carries the one-click entries, gated by the column', async ({ page }) => {
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();

    const planCard = page.locator('.tickets-card[data-id="T-0042"]').filter({ visible: true });
    await planCard.click({ button: 'right' });
    await expect(page.locator('.tickets-menu-item', { hasText: 'Plan with agent' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('app-editor .cm-content').click({ position: { x: 10, y: 10 } });

    const buildCard = page.locator('.tickets-card[data-id="T-0044"]').filter({ visible: true });
    await buildCard.click({ button: 'right' });
    await expect(page.locator('.tickets-menu-item', { hasText: 'Refine with agent' })).toHaveCount(0);
    await expect(page.locator('.tickets-menu-item', { hasText: 'Run agent' })).toBeVisible();
  });
});
