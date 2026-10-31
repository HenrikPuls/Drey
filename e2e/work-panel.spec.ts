import { test, expect } from './fixtures/drey';

/**
 * The Work panel (req-75 W1, ADR-0087): Needs you, Ideas and In progress
 * in place of the kanban columns, and a ticket's thread beside its file.
 * The fleet runner does not run under e2e, so the live runs arrive as a
 * pushed `fleet-changed` snapshot. The screenshots show the panel at its
 * default dock width (~340 px) and the whole window with a ticket open.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
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

function ticket(id: string, title: string, phase: string, priority = 'normal'): string {
  return [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    'repo: drey',
    `priority: ${priority}`,
    `branch: t/${id}`,
    `entered-inbox: '2026-10-2${id.slice(-1)}T09:00:00Z'`,
    ...(phase === 'inbox' ? [] : [`entered-${phase}: '2026-10-30T09:00:00Z'`]),
    '---',
    '',
    '## Description',
    '',
    `${title} — what the owner wants, in two sentences.`,
    '',
    '## Log',
    '',
  ].join('\n');
}

function liveRun(id: string, ticketId: string, column: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ticketId,
    provider: 'opencode',
    model: 'glm-5.3-flash',
    column,
    state: 'running',
    pid: 4242,
    startedAt: '2026-10-31T06:00:00Z',
    endedAt: null,
    sessionRef: 'ses-1',
    tokensIn: 41_200,
    tokensOut: 2_300,
    costUsd: null,
    lastActivity: new Date().toISOString(),
    steerCount: 0,
    worktreePath: '',
    ...extra,
  };
}

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/10-inbox/T-0101.md': ticket('T-0101', 'Dark mode for the calendar', 'inbox', 'high'),
    'tickets/10-inbox/T-0102.md': ticket('T-0102', 'Export tags as CSV', 'inbox', 'low'),
    'tickets/20-prioritized/T-0103.md': ticket('T-0103', 'Faster vault search', 'prioritized'),
    'tickets/30-plan/T-0107.md': ticket('T-0107', 'Daily note templates per weekday', 'plan'),
    'tickets/50-build/T-0104.md': ticket('T-0104', 'Drag headings in the outline', 'build', 'high'),
    'tickets/60-review/T-0105.md': ticket('T-0105', 'Spellcheck inside tables', 'review'),
    'tickets/80-done/T-0106.md': ticket('T-0106', 'Fix the palette race in CI', 'done'),
  },
});

test.describe('Work panel (req-75 W1)', () => {
  test('groups the tickets, and a ticket opens with its thread beside it', async ({ page, electronApp }, testInfo) => {
    // The Work panel gets the left dock to itself, as an owner would set it.
    await page.locator('app-dock-strip button[aria-label="Show Work"]').click();
    for (const other of ['Calendar', 'Files', 'Open windows']) {
      await page.locator(`app-dock-strip button[aria-label="Hide ${other}"]`).click();
    }
    const panel = page.locator('.tickets-panel').filter({ visible: true });
    await expect(panel.locator('.work-row[data-id="T-0101"]')).toBeVisible({ timeout: 15_000 });

    await electronApp.evaluate(
      ({ BrowserWindow }, data) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('plugin:event', data);
        }
      },
      {
        pluginId: 'tickets',
        event: 'fleet-changed',
        data: {
          runs: [
            liveRun('r-build', 'T-0104', 'build', {
              waiting: {
                kind: 'question',
                text: 'Should dragging a heading also move the text below it?',
                since: '2026-10-31T06:20:00Z',
              },
              turn: 'idle',
            }),
            liveRun('r-plan', 'T-0107', 'plan', { activity: 'Reading daily-note.ts' }),
          ],
          chain: null,
        },
      },
    );

    const group = (id: string) => panel.locator(`.work-group-${id} .work-row`);
    await expect(group('needs')).toHaveCount(3);
    await expect(group('needs').first()).toHaveAttribute('data-id', 'T-0104');
    await expect(panel.locator('.work-row[data-id="T-0104"] .work-row-line')).toHaveText(
      'Asks: Should dragging a heading also move the text below it?',
    );
    await expect(panel.locator('.work-row[data-id="T-0105"] .work-action')).toHaveText(['Approve → Commit', 'Refine with agent']);
    await expect(panel.locator('.work-row[data-id="T-0106"] .work-action')).toHaveText(['Accept']);
    // Ideas: priority first; the prioritized one carries the Queued chip.
    await expect(group('ideas')).toHaveCount(3);
    await expect(group('ideas').first()).toHaveAttribute('data-id', 'T-0101');
    await expect(panel.locator('.work-row[data-id="T-0103"] .work-row-queued')).toHaveText('Queued');
    await expect(group('progress')).toHaveCount(1);
    await expect(group('progress').first()).toHaveAttribute('data-id', 'T-0107');

    const box = (await panel.boundingBox())!;
    expect(box.width).toBeLessThan(420);
    await panel.screenshot({ path: testInfo.outputPath('work-panel-narrow.png') });

    // The ticket page: the file in the editor, the thread beside it with the question.
    await panel.locator('.work-row[data-id="T-0104"]').click();
    await expect(page.locator('app-editor .tickets-head')).toBeVisible({ timeout: 15_000 });
    const thread = page.locator('.tickets-thread').filter({ visible: true });
    await expect(thread).toBeVisible();
    await expect(thread.locator('.tickets-thread-title')).toHaveText('Drag headings in the outline');
    await expect(thread.locator('.tickets-takeover-wait-text')).toHaveText(
      'Should dragging a heading also move the text below it?',
    );
    await expect(panel.locator('.work-row[data-id="T-0104"]')).toHaveClass(/work-row-open/);
    await page.screenshot({ path: testInfo.outputPath('work-panel-wide.png') });

    // A second ticket reuses the one thread tab.
    await panel.locator('.work-row[data-id="T-0107"]').click();
    await expect(thread.locator('.tickets-thread-title')).toHaveText('Daily note templates per weekday');
    await expect(page.locator('.tickets-thread')).toHaveCount(1);
  });

  test('folds a group and keeps it folded', async ({ page }) => {
    await page.locator('app-dock-strip button[aria-label="Show Work"]').click();
    const panel = page.locator('.tickets-panel').filter({ visible: true });
    await expect(panel.locator('.work-row[data-id="T-0101"]')).toBeVisible({ timeout: 15_000 });
    await panel.locator('.work-group-ideas .work-group-head').click();
    await expect(panel.locator('.work-group-ideas .work-row')).toHaveCount(0);
    await expect(panel.locator('.work-group-ideas .work-group-count')).toHaveText('3');
    await panel.locator('.work-group-ideas .work-group-head').click();
    await expect(panel.locator('.work-group-ideas .work-row')).toHaveCount(3);
  });

  test('orders the groups, chips the phase and filters by status (T-0084)', async ({ page }) => {
    await page.locator('app-dock-strip button[aria-label="Show Work"]').click();
    const panel = page.locator('.tickets-panel').filter({ visible: true });
    await expect(panel.locator('.work-row[data-id="T-0101"]')).toBeVisible({ timeout: 15_000 });

    // In progress precedes Ideas; a row carries its phase chip.
    await expect(panel.locator('.work-group-title')).toHaveText(['In progress', 'Ideas']);
    await expect(panel.locator('.work-row[data-id="T-0101"] .work-phase-name')).toHaveText('Inbox');

    // The filter popover: one status chip hides the idle ideas.
    const head = page.locator('.tickets-panel-head').filter({ visible: true });
    await head.locator('.work-filter-btn').click();
    const pop = page.locator('.work-filter-pop');
    await expect(pop).toBeVisible();
    await pop.getByRole('button', { name: 'Idle', exact: true }).click();
    await expect(panel.locator('.work-group-ideas .work-row')).toHaveCount(1);
    await expect(panel.locator('.work-group-ideas .work-group-count')).toHaveText('1/3');
    await pop.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(panel.locator('.work-group-ideas .work-row')).toHaveCount(3);
    await expect(panel.locator('.work-group-ideas .work-group-count')).toHaveText('3');
  });
});
