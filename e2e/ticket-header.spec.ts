import { test, expect } from './fixtures/drey';

/**
 * The ticket header (req-62, SDK 1.34): a ticket file of the tickets vault
 * opens with a header in place of the folded frontmatter pill — the title
 * as an editable headline, the fields as a chip row — and its Log folded.
 * Changes are buffer edits (dirty, undoable), never file writes.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: plan, title: Plan, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

const TICKET = [
  '---',
  'id: T-0042',
  'title: "Fix the palette race in CI"',
  'repo: drey',
  'priority: high',
  'rank: 5000',
  'branch: t/T-0042',
  "entered-inbox: '2026-10-17T14:32:00Z'",
  "entered-plan: '2026-10-18T09:00:00Z'",
  '---',
  '',
  '## Description',
  '',
  'The palette opens twice when CI is slow.',
  '',
  '## Plan',
  '',
  'To be filled in the plan phase.',
  '',
  '## Log',
  '',
  "- '2026-10-17T14:32:00Z' owner@desk — created in inbox",
  "- '2026-10-18T09:00:00Z' owner@desk — inbox -> plan",
  '',
].join('\n');

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/_meta/order.md': '# Column order pins\n',
    'tickets/20-plan/T-0042.md': TICKET,
    'plain.md': '---\ntitle: "A plain note"\n---\n\n# Plain\n',
  },
});

test.describe('Ticket header in the editor (req-62)', () => {
  test('shows title and fields, edits them as buffer changes, folds the Log', async ({ page }) => {
    // The board's card opens the ticket — the owner's path.
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
    await page.locator('.tickets-card[data-id="T-0042"]').filter({ visible: true }).click();

    const head = page.locator('app-editor .tickets-head');
    await expect(head).toBeVisible({ timeout: 15_000 });
    await expect(head.locator('.tickets-head-title')).toHaveValue('Fix the palette race in CI');
    await expect(head.locator('.tickets-head-id')).toHaveText('T-0042');
    await expect(head.locator('.tickets-head-phase')).toHaveText('Plan');
    await expect(head.locator('select[aria-label="Priority"]')).toHaveValue('high');
    await expect(head.locator('select[aria-label="Repository"]')).toHaveValue('drey');
    await expect(page.locator('app-editor .cm-fm-pill')).toHaveCount(0);

    // The Log folds on first show: its lines are gone, the heading stays.
    await expect(page.locator('app-editor .cm-content')).toContainText('Log');
    await expect(page.locator('app-editor .cm-content')).not.toContainText('inbox -> plan');
    await page.screenshot({ path: test.info().outputPath('ticket-header.png') });

    // A priority pick and a title edit are buffer edits.
    await head.locator('select[aria-label="Priority"]').selectOption('urgent');
    await expect(head.locator('select[aria-label="Priority"]')).toHaveValue('urgent');
    const title = head.locator('.tickets-head-title');
    await title.fill('CI: fix the palette race');
    await title.press('Enter');
    await expect(page.locator('app-editor .tickets-head-title')).toHaveValue('CI: fix the palette race');

    // The raw YAML shows the rewritten keys.
    await head.locator('button[aria-label="Edit the frontmatter as YAML"]').click();
    const content = page.locator('app-editor .cm-content');
    await expect(content).toContainText('priority: urgent');
    await expect(content).toContainText('title: "CI: fix the palette race"');
    await page.screenshot({ path: test.info().outputPath('ticket-header-raw.png') });

    // Undo walks the header's edits back like typing.
    await page.locator('app-editor .cm-content').click();
    await page.keyboard.press('Control+z');
    await expect(content).toContainText('title: "Fix the palette race in CI"');

    // A plain note keeps the base pill.
    await page.locator('app-files-panel .node.file', { hasText: 'plain.md' }).click();
    await expect(page.locator('app-editor .cm-fm-pill')).toBeVisible();
    await expect(page.locator('app-editor .tickets-head')).toHaveCount(0);
  });
});
