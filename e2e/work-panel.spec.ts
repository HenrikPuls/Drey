import { test, expect } from './fixtures/drey';

/**
 * The Work panel (req-75 W1/W1b, ADR-0087): Needs you, Shaping, Running
 * and Ideas in place of the kanban columns; a Work row opens a ticket's
 * thread alone (req-84) — its header, its decision bar and the question
 * it waits on — and only the row menu's Open ticket adds the file beside
 * it. The fleet runner does not run under e2e, so the live runs arrive as
 * a pushed `fleet-changed` snapshot. The screenshots show the panel at its
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

function ticket(id: string, title: string, phase: string, priority = 'normal', interactive = false): string {
  return [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    'repo: drey',
    `priority: ${priority}`,
    `branch: t/${id}`,
    `entered-inbox: '2026-10-2${id.slice(-1)}T09:00:00Z'`,
    ...(phase === 'inbox' ? [] : [`entered-${phase}: '2026-10-30T09:00:00Z'`]),
    ...(interactive ? ['interactive: true'] : []),
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
    'tickets/50-build/T-0108.md': ticket('T-0108', 'Weekly security audit run', 'build', 'normal', true),
    'tickets/50-build/T-0104.md': ticket('T-0104', 'Drag headings in the outline', 'build', 'high'),
    'tickets/60-review/T-0105.md': ticket('T-0105', 'Spellcheck inside tables', 'review'),
    // A finished ticket carries the build worker's `## Changes`: the final card reports from it.
    'tickets/80-done/T-0106.md': ticket('T-0106', 'Fix the palette race in CI', 'done').replace(
      '## Log',
      '## Changes\n\n**What changed for you:** The palette opens once, even on a double press.\n\n## Log',
    ),
  },
});

test.describe('Work panel (req-75 W1/W1b)', () => {
  test('groups the tickets, and a row opens the ticket thread alone', async ({ page, electronApp }, testInfo) => {
    // The Work panel gets the left dock to itself, as an owner would set it.
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
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

    const group = (id: string) => panel.locator(`.work-group-${id}`);
    const rows = (id: string) => group(id).locator('.work-row');
    // Needs you: the question, the review checkpoint, the finished ticket.
    await expect(rows('needs')).toHaveCount(3);
    await expect(rows('needs').first()).toHaveAttribute('data-id', 'T-0104');
    await expect(panel.locator('.work-row[data-id="T-0104"] .work-kind')).toHaveText('Question');
    await expect(panel.locator('.work-row[data-id="T-0104"] .work-row-line')).toHaveText(
      'Should dragging a heading also move the text below it?',
    );
    await expect(panel.locator('.work-row[data-id="T-0105"] .work-kind')).toHaveText('Review');
    await expect(panel.locator('.work-row[data-id="T-0105"] .work-row-line')).toHaveText('waits for your review');
    await expect(panel.locator('.work-row[data-id="T-0106"] .work-kind')).toHaveText('Ready to try');
    // Shaping holds the reserved dialog (its phase chip names the column);
    // Running the live plan run; the ideas keep their queue chip and carry
    // the triage chip.
    await expect(rows('shaping')).toHaveCount(1);
    await expect(rows('shaping').first()).toHaveAttribute('data-id', 'T-0108');
    await expect(panel.locator('.work-row[data-id="T-0108"] .work-row-line')).toHaveText('Dialog not started');
    await expect(rows('running')).toHaveCount(1);
    await expect(rows('running').first()).toHaveAttribute('data-id', 'T-0107');
    await expect(panel.locator('.work-row[data-id="T-0107"] .work-run-step')).toHaveText('Planning');
    // The queued idea is the Prioritized group's (E13-8); Ideas keeps the inbox ones.
    await expect(rows('prioritized')).toHaveCount(1);
    await expect(rows('ideas')).toHaveCount(2);
    await expect(rows('ideas').first()).toHaveAttribute('data-id', 'T-0101');
    await expect(panel.locator('.work-row[data-id="T-0103"] .work-row-queued')).toHaveText('Queued');
    await expect(panel.locator('.work-row[data-id="T-0102"] .work-track')).toHaveText('Triage');
    // The footer is the crew line (E12-11): who is busy, one click to the Crew tab; the
    // header is one row ending in the Open Board tab icon, and no Workers cards sit above the groups.
    await expect(panel.locator('.tickets-statusbar-fleet')).toHaveText('Crew · 2 busy');
    await expect(panel.locator('.tickets-workers')).toHaveCount(0);
    await expect(page.locator('button[aria-label="Open Board tab"]:visible')).toHaveCount(1);

    const box = (await panel.boundingBox())!;
    expect(box.width).toBeLessThan(420);
    await panel.screenshot({ path: testInfo.outputPath('work-panel-narrow.png') });

    // A Work row opens the thread alone (req-84): since W4a the worker
    // lives there in every state (the run tab is gone) — no file pair,
    // no second pane; the thread lands where the focus is.
    await panel.locator('.work-row[data-id="T-0104"]').click();
    const thread = page.locator('.tickets-thread').filter({ visible: true });
    await expect(thread).toBeVisible({ timeout: 15_000 });
    await expect(thread.locator('.tickets-thread-title')).toHaveText('Drag headings in the outline');
    // The worker lives on the ticket (req-75 W4a): the header's bold state
    // word says what it does, the meta line names it — and the takeover
    // tab's Open run is gone, its controls live here now.
    await expect(thread.locator('.tickets-thread-state')).toHaveText('Waiting for you');
    await expect(thread.locator('.tickets-thread-meta')).toHaveText(/OpenCode · glm-5.3-flash/);
    await expect(thread.getByTitle('Open the run in its own tab', { exact: false })).toHaveCount(0);
    // Pause only exists while a turn runs (an idle turn has nothing to
    // interrupt); Take over and Stop are always there while connected.
    await expect(thread.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    await expect(thread.getByRole('button', { name: 'Take over' })).toBeVisible();
    await expect(thread.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    // The question is part of the conversation now (req-75 W2b): no card.
    await expect(thread.locator('.tickets-takeover-wait')).toBeHidden();
    await expect(thread.locator('.tickets-ask-question')).toHaveText(
      'Should dragging a heading also move the text below it?',
    );
    // A question carries no decision bar — that is the checkpoints'.
    await expect(thread.locator('.tickets-thread-decisions')).toBeHidden();
    await expect(page.locator('app-pane-leaf')).toHaveCount(1);
    await expect(panel.locator('.work-row[data-id="T-0104"]')).toHaveClass(/work-row-open/);
    await page.screenshot({ path: testInfo.outputPath('work-panel-wide.png') });

    // The decisions live in the thread (req-75 W1b); for a Review or
    // Ready-to-try checkpoint the Ready card's buttons replace the bar
    // (req-75 W3, req-86): a gate offers the move to the next column (Launch
    // only with a worktree — none here), the terminal column Archive alone.
    const readyButtons = thread.locator('.tickets-ready-card .tickets-takeover-btn');
    await panel.locator('.work-row[data-id="T-0105"]').click();
    await expect(thread.locator('.tickets-thread-title')).toHaveText('Spellcheck inside tables');
    await expect(thread.locator('.tickets-thread-decisions')).toBeHidden();
    await expect(readyButtons).toHaveText(['Move to Commit', 'Send back…']);
    await panel.locator('.work-row[data-id="T-0106"]').click();
    await expect(thread.locator('.tickets-thread-title')).toHaveText('Fix the palette race in CI');
    await expect(readyButtons).toHaveText(['Archive']);
    await expect(thread.locator('.tickets-ready-section b').first()).toHaveText('What changed for you');

    // The checkpoint actions live in the status row too (req-81) — always
    // there — and the chip folds the card to its strip (the buttons move
    // into it, the agent log gets the height) and brings it back.
    await expect(thread.locator('.tickets-thread-checkpoints button')).toHaveCount(3);
    await expect(thread.locator('.tickets-thread-chip')).toHaveText('Report ⌄');
    await thread.locator('.tickets-thread-chip').click();
    await expect(thread.locator('.tickets-ready-body-host')).toBeHidden();
    await expect(thread.locator('.tickets-ready-bar .tickets-ready-actions button')).toHaveText(['Archive']);
    await thread.locator('.tickets-thread-chip').click();
    await expect(thread.locator('.tickets-ready-body-host')).toBeVisible();
    await expect(readyButtons).toHaveText(['Archive']);

    // A second row reuses the one thread tab (req-84): the live run's
    // doings live in the thread too — never a second thread, never a
    // new pane.
    await panel.locator('.work-row[data-id="T-0107"]').click();
    await expect(thread.locator('.tickets-thread-title')).toHaveText('Daily note templates per weekday');
    await expect(page.locator('.tickets-thread')).toHaveCount(1);
    await expect(page.locator('app-pane-leaf')).toHaveCount(1);
  });

  test('rows reuse the one thread tab; Open ticket opens the pair', async ({ page }, testInfo) => {
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
    const panel = page.locator('.tickets-panel').filter({ visible: true });
    await expect(panel.locator('.work-row[data-id="T-0101"]')).toBeVisible({ timeout: 15_000 });

    // A row opens the thread alone (req-84) — no file, no split.
    await panel.locator('.work-row[data-id="T-0101"]').click();
    const thread = page.locator('.tickets-thread').filter({ visible: true });
    await expect(thread.locator('.tickets-thread-title')).toHaveText('Dark mode for the calendar');
    await expect(page.locator('app-pane-leaf')).toHaveCount(1);

    // The next rows switch the same tab in place.
    for (const [id, title] of [
      ['T-0102', 'Export tags as CSV'],
      ['T-0103', 'Faster vault search'],
    ] as const) {
      await panel.locator(`.work-row[data-id="${id}"]`).click();
      await expect(thread.locator('.tickets-thread-title')).toHaveText(title);
      await expect(page.locator('.tickets-thread')).toHaveCount(1);
      await expect(page.locator('app-pane-leaf')).toHaveCount(1);
    }

    // The row menu's Open ticket keeps the pair (req-84): the ticket file
    // with the thread beside it — one split, and nothing stacks further.
    await panel.locator('.work-row[data-id="T-0103"] .work-row-more').click();
    await page.locator('.tickets-menu .tickets-menu-item', { hasText: 'Open ticket' }).click();
    await expect(page.locator('app-tab-bar .tab', { hasText: 'T-0103.md' })).toHaveCount(1);
    await expect(page.locator('app-pane-leaf')).toHaveCount(2);
    await expect(page.locator('.tickets-thread')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('ticket-page-no-split.png') });
  });

  test('an ended run keeps the box free: no run link in the header, the toolbar inside the box', async ({
    page,
    electronApp,
  }, testInfo) => {
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
    const panel = page.locator('.tickets-panel').filter({ visible: true });
    await expect(panel.locator('.work-row[data-id="T-0107"]')).toBeVisible({ timeout: 15_000 });
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
          runs: [liveRun('r-ended', 'T-0107', 'plan', { state: 'done', endedAt: '2026-10-31T07:00:00Z', exitCode: 1 })],
          chain: null,
        },
      },
    );
    await panel.locator('.work-row[data-id="T-0107"]').click();
    const thread = page.locator('.tickets-thread').filter({ visible: true });
    // The state word says how it ended (W4a); the meta line names the
    // worker — and no run link: the run's doings live in the thread.
    await expect(thread.locator('.tickets-thread-state')).toHaveText('Ended');
    await expect(thread.locator('.tickets-thread-meta')).toHaveText(/^OpenCode · glm-5.3-flash/);
    await expect(thread.locator('.tickets-thread-head button[aria-label^="Open the run"]')).toHaveCount(0);
    const box = thread.locator('.tickets-composer-box');
    await expect(box.locator('.tickets-composer-toolbar .tickets-composer-send')).toBeEnabled();
    // The quick-prompt chips sit in their own row above the box (W4a) and
    // stay clickable for an ended run with a session.
    await expect(thread.locator('.tickets-composer-chips .tickets-takeover-chip').first()).toBeEnabled();
    // Send sits at the toolbar's right end, under the prompt, inside the box.
    const sendBox = (await box.locator('.tickets-composer-send').boundingBox())!;
    const promptBox = (await box.locator('.tickets-takeover-prompt-input').boundingBox())!;
    const outer = (await box.boundingBox())!;
    expect(sendBox.y).toBeGreaterThanOrEqual(promptBox.y + promptBox.height - 1);
    expect(outer.x + outer.width - (sendBox.x + sendBox.width)).toBeLessThan(16);
    await thread.screenshot({ path: testInfo.outputPath('thread-ended-run.png') });
  });

  test('folds a group and keeps it folded', async ({ page }) => {
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
    const panel = page.locator('.tickets-panel').filter({ visible: true });
    await expect(panel.locator('.work-row[data-id="T-0101"]')).toBeVisible({ timeout: 15_000 });
    await panel.locator('.work-group-ideas .work-group-head').click();
    await expect(panel.locator('.work-group-ideas .work-row')).toHaveCount(0);
    await expect(panel.locator('.work-group-ideas .work-group-count')).toHaveText('2');
    await panel.locator('.work-group-ideas .work-group-head').click();
    await expect(panel.locator('.work-group-ideas .work-row')).toHaveCount(2);
  });

  test('orders the groups and filters by status (T-0084)', async ({ page }) => {
    await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
    const panel = page.locator('.tickets-panel').filter({ visible: true });
    await expect(panel.locator('.work-row[data-id="T-0101"]')).toBeVisible({ timeout: 15_000 });

    // The canvas order (W1b, E13-8): Needs you, Running, Shaping, Prioritized,
    // Ideas — the seeded review checkpoint and finished ticket fill the first.
    await expect(panel.locator('.work-group-title')).toHaveText(['Needs you', 'Running', 'Shaping', 'Prioritized', 'Ideas']);

    // The filter popover: the Idle chip keeps the idle ideas — the queued
    // one (and only it) goes.
    const head = page.locator('.tickets-panel-head').filter({ visible: true });
    await head.locator('.work-filter-btn').click();
    const pop = page.locator('.work-filter-pop');
    await expect(pop).toBeVisible();
    await pop.getByRole('button', { name: 'Idle', exact: true }).click();
    await expect(panel.locator('.work-group-ideas .work-row')).toHaveCount(2);
    await expect(panel.locator('.work-group-prioritized .work-row[data-id="T-0103"]')).toHaveCount(0);
    await expect(panel.locator('.work-group-prioritized .work-group-count')).toHaveText('0/1');
    await pop.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(panel.locator('.work-group-prioritized .work-row')).toHaveCount(1);
    await expect(panel.locator('.work-group-ideas .work-group-count')).toHaveText('2');
  });
});
