import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

// The tickets engine is one process per user (`~/.drey-engine/engine.lock`),
// adopted by every Drey that starts: without a home of its own this test
// would talk to the owner's live engine and board. A home of its own makes
// the plugin spawn an engine for the seeded vault (this checkout's build).
const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

/** Stops the engine this test's Drey spawned (it outlives Drey by design). */
function stopEngine(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(engineHome, '.drey-engine', 'engine.lock'), 'utf8')) as { pid?: number };
    if (typeof lock.pid === 'number') {
      process.kill(lock.pid);
    }
  } catch {
    // no engine was started, or it is already gone
  }
}

test.afterAll(() => {
  stopEngine();
  fs.rmSync(engineHome, { recursive: true, force: true });
});

/**
 * The desk surfaces (E13-8): the Board and Team tabs and the Capacity
 * band over a seeded tickets vault with a team, a ledger of settled runs
 * and a plan with parts. The fleet runner does not run under e2e, so the
 * live runs arrive as a pushed `fleet-changed` snapshot (as in the Work
 * panel spec). The screenshots in the test output are the evidence the
 * milestone's changelog entry names.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, persona: paul }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: review, title: Review, handover: manual }',
  '  - { id: commit, title: Commit, handover: agent commit-default }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

function ticket(id: string, title: string, phase: string, extra: string[] = []): string {
  return [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    'repo: drey',
    'priority: normal',
    `branch: t/${id}`,
    `entered-inbox: '2026-10-2${id.slice(-1)}T09:00:00Z'`,
    ...(phase === 'inbox' ? [] : [`entered-${phase}: '2026-10-30T09:00:00Z'`]),
    ...extra,
    '---',
    '',
    '## Description',
    '',
    `${title} - what the owner wants, in two sentences.`,
    '',
    '## Log',
    '',
  ].join('\n');
}

function persona(title: string, role: string, color: string, budget: number, worker = 'opencode'): string {
  return ['---', `title: ${title}`, `role: ${role}`, `worker: ${worker}`, 'models:', '  default: qwen3-coder', '  pool: [qwen3-coder]', '  router: off', `color: '${color}'`, 'skills: []', `budget: ${budget}`, '---', `Who ${title} is.`, ''].join('\n');
}

const now = new Date();
const settled = (ticketId: string, personaId: string, cost: number): string =>
  JSON.stringify({ v: 1, ts: now.toISOString(), event: 'run_settled', ticket: ticketId, persona: personaId, model: 'qwen3-coder', tokensIn: 40_000, tokensOut: 3_000, cost });

const PLAN_TICKET = ticket('T-0130', 'Voice capture for tickets', 'review').replace(
  '## Log',
  [
    '## Plan',
    '',
    '### Parts',
    '',
    '- [ ] Capture hotkey and window',
    '  persona: ben',
    '- [ ] Dictation hand-off',
    '  persona: ben',
    '- [ ] Ticket from transcript',
    '  persona: paul',
    '',
    '## Log',
  ].join('\n'),
);

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#a78bfa', 3),
    'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#3b82f6', 5),
    'tickets/_meta/personas/ralf/persona.md': persona('Ralf', 'reviewer', '#10b981', 4),
    'tickets/_meta/personas/tessa/persona.md': persona('Tessa', 'tester', '#f59e0b', 7),
    'tickets/_meta/ledger.jsonl': [settled('T-0121', 'ben', 1.2), settled('T-0126', 'ben', 2.05), settled('T-0130', 'paul', 0.61), settled('T-0126', 'tessa', 0.36), ''].join('\n'),
    'tickets/10-inbox/T-0133.md': ticket('T-0133', 'Sync status in the title bar', 'inbox'),
    'tickets/10-inbox/T-0131.md': ticket('T-0131', 'Dark mode for the PDF export', 'inbox'),
    'tickets/20-prioritized/T-0127.md': ticket('T-0127', 'Spellcheck: add French dictionary', 'prioritized'),
    'tickets/40-build/T-0121.md': ticket('T-0121', 'Outline: drag headings to reorder', 'build'),
    'tickets/40-build/T-0126.md': ticket('T-0126', 'Git panel: stage single hunks', 'build'),
    'tickets/50-review/T-0130.md': PLAN_TICKET,
    'tickets/40-build/T-0141.md': ticket('T-0141', 'Capture hotkey and window', 'build', ['parent: T-0130']),
  },
});

function liveRun(id: string, ticketId: string, personaId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    ticketId,
    persona: personaId,
    provider: 'opencode',
    model: 'qwen3-coder',
    column: 'build',
    state: 'running',
    pid: 4242,
    startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
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

test.describe('Board, Team and Capacity (E13-8)', () => {
  test('shows the board, the team and the capacity band', async ({ page, electronApp }, testInfo) => {
    // The Work view exists once the plugin has registered it; Ctrl+2 before that does nothing.
    await expect(page.locator('[role="tablist"][aria-label="Views"] [role="tab"]')).toHaveText(['Notes', 'Work'], { timeout: 30_000 });
    // The title bar carries no capture button (board 9a); it is the Work panel's first header action (board 7a).
    await expect(page.locator('app-titlebar .tb-action')).toHaveCount(0);
    // The status items (E12-15): today's cost and what waits, "in Work" from the Notes view.
    const statusBar = page.locator('app-status-bar');
    await expect(statusBar).toContainText(/\$\d+\.\d\d of \$\d+ today/, { timeout: 15_000 });
    await expect(statusBar).toContainText(/needs? you in Work/);

    // The Work view (Ctrl+2) puts the Tickets panel and the Capacity band in place.
    await page.keyboard.press('Control+2');
    const panel = page.locator('.tickets-panel').filter({ visible: true });
    await expect(panel.locator('.work-row[data-id="T-0121"]')).toBeVisible({ timeout: 15_000 });
    await expect(statusBar).not.toContainText('in Work');

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
            liveRun('r-ben', 'T-0121', 'ben', {
              waiting: { kind: 'question', text: 'Move the section body too?', since: new Date(Date.now() - 4 * 60_000).toISOString() },
              turn: 'idle',
            }),
            liveRun('r-tessa', 'T-0126', 'tessa', {
              activity: 'Running the unit tests',
              stuck: true,
              lastActivity: new Date(Date.now() - 9 * 60_000).toISOString(),
              contextTokens: 78_000,
              contextWindow: 100_000,
            }),
          ],
          chain: {
            configured: true,
            master: 'run',
            columns: {},
            redStreak: {},
            cooldownUntil: {},
            poolSize: { opencode: 2, 'claude-code': 3 },
          },
        },
      },
    );

    // Prioritized is its own group in the list, rows carry persona and cost.
    await expect(panel.locator('.work-group-prioritized .work-row[data-id="T-0127"]')).toBeVisible();
    await expect(panel.locator('.work-row[data-id="T-0121"] .work-row-cost')).toHaveText('$1.20');

    const openFromMenu = async (label: string): Promise<void> => {
      await page.locator('button[aria-label="More actions"]:visible').click();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
    };

    // --- Board
    await openFromMenu('Board');
    const board = page.locator('.desk-board').filter({ visible: true });
    await expect(board).toBeVisible({ timeout: 15_000 });
    await expect(board.locator('.desk-col-title')).toHaveText(['Inbox', 'Prioritized', 'Plan', 'Build', 'Review', 'Commit', 'Done this week']);
    const build = board.locator('[data-phase="build"]');
    await expect(build.locator('.desk-col-cost')).toHaveText('$3.61');
    await expect(build.locator('[data-id="T-0121"] .desk-card-who')).toContainText('Ben');
    await expect(build.locator('[data-id="T-0121"] .desk-card-cost')).toHaveText('$1.20');
    // The released part hangs under its ticket; the plan's unreleased parts too.
    const plan = board.locator('[data-id="T-0130"]');
    await expect(plan.locator('.desk-part')).toHaveCount(3, { timeout: 15_000 });
    await expect(plan.locator('.desk-part-handle').first()).toHaveText('T-0141');
    await expect(board.locator('[data-phase="build"] [data-id="T-0141"]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('desk-board.png') });
    // Scroll to the later columns; a repaint (a refreshed board) keeps the place.
    // Every repaint rebuilds the columns, and the engine's first board rounds
    // still arrive here: a handle on `build` can be a node already replaced, so
    // the scroll goes through the board's root, which stays. The mark on the
    // scrolled columns tells when a repaint has really replaced them.
    const scrolled = await board.evaluate((root) => {
      const columns = root.querySelector<HTMLElement>('.desk-cols')!;
      columns.dataset['e2eScrolled'] = 'yes';
      root.querySelector('[data-phase="build"]')!.scrollIntoView({ inline: 'start', block: 'nearest' });
      return columns.scrollLeft;
    });
    expect(scrolled).toBeGreaterThan(0);
    await openFromMenu('Refresh the board');
    await expect(board.locator('.desk-cols[data-e2e-scrolled]')).toHaveCount(0);
    expect(await board.evaluate((root) => root.querySelector('.desk-cols')!.scrollLeft)).toBeCloseTo(scrolled, 0);
    await page.screenshot({ path: testInfo.outputPath('desk-board-build.png') });

    // --- Team
    await openFromMenu('Crew');
    const team = page.locator('.desk-team').filter({ visible: true });
    await expect(team).toBeVisible({ timeout: 15_000 });
    await expect(team.locator('.desk-head-sub')).toHaveText('4 personas · 1 waiting · 1 stuck');
    await expect(team.locator('.desk-budget')).toContainText('of $19 today');
    await expect(team.locator('[data-persona="ben"] .desk-persona-state')).toHaveText('waiting');
    await expect(team.locator('[data-persona="tessa"] .desk-persona-state')).toHaveText('stuck');
    await expect(team.locator('[data-persona="tessa"] .desk-persona-headline')).toHaveText('No output for 9 min on T-0126');
    await expect(team.locator('[data-persona="tessa"] .desk-persona-controls button')).toHaveAttribute('aria-label', /Nudge the worker|Hand to Claude Code|Stop/);
    await expect(team.locator('[data-persona="ben"] .desk-persona-role')).toHaveText('Builder · $3.25 today');
    // The persona detail sits under the cards: the first persona is selected, Setup first.
    await expect(team.locator('.desk-tab')).toHaveText(['Setup', 'Memory', '1:1']);
    await expect(team.locator('.desk-pool-model')).toHaveText('qwen3-coder');
    await page.screenshot({ path: testInfo.outputPath('desk-team.png') });

    // --- Capacity band in the bottom dock: only on the Board tab (board 7e; the Crew tab, 7f, has none)
    await expect(page.locator('.desk-capacity')).toBeHidden();
    await openFromMenu('Board');
    const band = page.locator('.desk-capacity').filter({ visible: true });
    await expect(band).toBeVisible({ timeout: 15_000 });
    await expect(band.locator('.desk-cap-person').filter({ hasText: 'Tessa' })).toContainText('stuck on T-0126');
    await expect(band.locator('.desk-cap-today')).toHaveText('$4.22 of $19 today');
    await page.screenshot({ path: testInfo.outputPath('desk-capacity.png') });

    // The band rule (E12-15, board 7e): hidden once another tab (a ticket) is the active one.
    await panel.locator('.work-row[data-id="T-0121"]').click();
    await expect(page.locator('.desk-capacity')).toBeHidden({ timeout: 15_000 });
    stopEngine();
  });
});
