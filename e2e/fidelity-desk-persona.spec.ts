import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from './fixtures/drey';

/**
 * NOT a regression suite: puts the built app in the state of board 7k
 * (DeskPersona) and takes the screenshot the fidelity checklist asks for.
 * Opt-in, so CI skips it:
 *
 *   . .\env.ps1
 *   $env:DREY_FIDELITY_SHOTS = '1'
 *   npm run e2e:run -- fidelity-desk-persona
 *
 * Output: `test-results/fidelity/DeskPersona.png` (1440x900, scale factor 1).
 */
const RUN = !!process.env['DREY_FIDELITY_SHOTS'];
test.skip(!RUN, 'set DREY_FIDELITY_SHOTS=1 -- the screenshot of board 7k');

const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

test.afterAll(() => {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(engineHome, '.drey-engine', 'engine.lock'), 'utf8')) as { pid?: number };
    if (typeof lock.pid === 'number') {
      process.kill(lock.pid);
    }
  } catch {
    // no engine was started, or it is already gone
  }
  fs.rmSync(engineHome, { recursive: true, force: true });
});

const OUT = path.resolve(__dirname, '..', 'test-results', 'fidelity');

/** The board's six steps of a flow, with the columns the Work panel of 7a groups by. */
const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: shaping, title: Shaping, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: shape, title: Shape, handover: agent plan-default, persona: paul }',
  '  - { id: plan, title: Plan, handover: agent plan-default, persona: paul }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: review, title: Review, handover: agent review-default, persona: ralf }',
  '  - { id: security, title: Security, handover: agent review-default, persona: ralf }',
  '  - { id: test, title: Test, handover: agent review-default, persona: tessa }',
  '  - { id: ready, title: Ready to try, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

function ticket(id: string, title: string, phase: string): string {
  return ['---', `id: ${id}`, `title: "${title}"`, 'repo: drey', 'priority: normal', `branch: t/${id}`, "entered-inbox: '2026-10-20T09:00:00Z'", ...(phase === 'inbox' ? [] : [`entered-${phase}: '2026-10-30T09:00:00Z'`]), '---', '', '## Description', '', `${title} - what the owner wants.`, '', '## Log', ''].join('\n');
}

const BEN = ['---', 'title: Ben', 'role: builder', 'worker: opencode', 'models:', '  default: qwen3-coder', '  pool: [qwen3-coder, sonnet]', '  router: off', "color: '#8ecbef'", 'skills: [go-conventions, tdd]', 'budget: 5', '---', 'Who Ben is.', ''].join('\n');

const other = (title: string, role: string, color: string): string =>
  ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: qwen3-coder', '  pool: [qwen3-coder]', '  router: off', `color: '${color}'`, 'skills: []', 'budget: 3', '---', `Who ${title} is.`, ''].join('\n');

const PROMPT = [
  'You are Ben, the builder on this crew. You implement exactly one part of a ticket, in its own worktree, and change nothing outside the files the part names.',
  '',
  '## How you work',
  '- Write the failing test first.',
  '- Keep each commit small and name it after the part.',
  '- Prefer the existing helpers over new abstractions.',
  '',
  '## Done means',
  'Tests green, rebased on main, no new lint warnings, and the acceptance criteria of the part ticked in the ticket.',
].join('\n');

const IMPROVEMENTS = [
  '# Improvements — ben',
  '',
  "- aggregate: '2026-11-02T10:00:00Z'",
  '',
  '- imp-1 open prompt.md — Add “Read the ADR index before adding a new component.”',
  "  - proposed: '2026-11-02T10:00:00Z'",
  '  - evidence:',
  '    - 2026-11-01 · T-0007 · guessed a convention',
  '    - 2026-11-01 · T-0009 · missed an ADR',
  '    - 2026-11-02 · T-0011 · the same obstacle twice',
  '  - content:',
  `      ${PROMPT.split('\n')[0]}`,
  '',
].join('\n');

const settled = (ticketId: string, personaId: string, cost: number): string =>
  JSON.stringify({ v: 1, ts: new Date().toISOString(), event: 'run_settled', ticket: ticketId, persona: personaId, model: 'qwen3-coder', tokensIn: 40_000, tokensOut: 3_000, cost });

const seed: Record<string, string> = {
  'tickets/_meta/pipeline.md': PIPELINE,
  'tickets/_meta/repos.md': REPOS,
  'tickets/_meta/personas/ben/persona.md': BEN,
  'tickets/_meta/personas/ben/prompt.md': PROMPT,
  'tickets/_meta/personas/ben/improvements.md': IMPROVEMENTS,
  'tickets/_meta/personas/paul/persona.md': other('Paul', 'planner', '#f2d3e2'),
  'tickets/_meta/personas/ralf/persona.md': other('Ralf', 'reviewer', '#bfe3cd'),
  'tickets/_meta/personas/tessa/persona.md': other('Tessa', 'tester', '#f2cfae'),
  'tickets/_meta/ledger.jsonl': [settled('T-0121', 'ben', 1.2), settled('T-0130', 'paul', 0.61), settled('T-0118', 'tessa', 1.84), settled('T-0126', 'tessa', 2.05), ''].join('\n'),
  'tickets/10-inbox/T-0131.md': ticket('T-0131', 'Dark mode for the PDF export', 'inbox'),
  'tickets/10-inbox/T-0129.md': ticket('T-0129', 'Auto OWASP check against cheat sheets', 'inbox'),
  'tickets/20-shaping/T-0119.md': ticket('T-0119', 'Weekly security audit run', 'shaping'),
  'tickets/30-prioritized/T-0127.md': ticket('T-0127', 'Spellcheck: add French dictionary', 'prioritized'),
  'tickets/30-prioritized/T-0128.md': ticket('T-0128', 'Tag rename keeps pill colors', 'prioritized'),
  'tickets/60-build/T-0121.md': ticket('T-0121', 'Outline: drag headings to reorder', 'build'),
  'tickets/60-build/T-0126.md': ticket('T-0126', 'Git panel: stage single hunks', 'build'),
  'tickets/60-build/T-0122.md': ticket('T-0122', 'Win+H dictation hand-off', 'build'),
  'tickets/110-ready/T-0118.md': ticket('T-0118', 'Palette opens twice on slow CI', 'ready'),
  'tickets/120-done/T-0115.md': ticket('T-0115', 'Tag rename keeps descendants', 'done'),
};

function liveRun(id: string, ticketId: string, personaId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, ticketId, persona: personaId, provider: 'opencode', model: 'qwen3-coder', column: 'build', state: 'running', pid: 4242, startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), endedAt: null, sessionRef: 'ses-1', tokensIn: 41_200, tokensOut: 2_300, costUsd: null, lastActivity: new Date().toISOString(), steerCount: 0, worktreePath: '', ...extra };
}

async function pushFleet(app: ElectronApplication): Promise<void> {
  await app.evaluate(
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
          liveRun('r-ben', 'T-0121', 'ben', { waiting: { kind: 'question', text: 'Move the section body too?', since: new Date(Date.now() - 4 * 60_000).toISOString() }, turn: 'idle' }),
          liveRun('r-tessa', 'T-0126', 'tessa', { activity: 'Running the unit tests', stuck: true, lastActivity: new Date(Date.now() - 9 * 60_000).toISOString() }),
        ],
        chain: { configured: true, master: 'run', columns: {}, redStreak: {}, cooldownUntil: {}, poolSize: { opencode: 2, 'claude-code': 3 } },
      },
    },
  );
}

async function sizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.getURL().startsWith('app://')) {
        win.setContentSize(1440, 900);
      }
    }
  });
}

/** 7k's docks: Tickets alone on the left; the right dock is folded later; no band in the bottom dock. */
async function arrangeDocks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ids = new Map<string, string>();
    for (const btn of document.querySelectorAll<HTMLElement>('app-dock-strip button[data-widget]')) {
      ids.set((btn.getAttribute('title') ?? '').split(' · ')[0] ?? '', btn.dataset['widget'] ?? '');
    }
    const named = (names: string[]): string[] => names.map((n) => ids.get(n)).filter((id): id is string => id !== undefined);
    const left = named(['Calendar', 'Files', 'Backlinks', 'Source control', 'Outline', 'Tasks', 'Tickets']);
    const right = named(['Search', 'Assistant']);
    const all = [...ids.values()];
    const saved = JSON.parse(localStorage.getItem('drey.dock') ?? '{}') as { active: string; views: Record<string, Record<string, unknown>> };
    saved.views[saved.active] = {
      ...saved.views[saved.active],
      dock: { left: left.concat(all.filter((id) => !left.includes(id) && !right.includes(id))), right, bottom: [] },
      open: Object.fromEntries(all.map((id) => [id, named(['Tickets', 'Assistant']).includes(id)])),
      flexes: Object.fromEntries(all.map((id) => [id, 1])),
      collapsed: Object.fromEntries(named(['Search']).map((id) => [id, true])),
      leftW: 300,
      rightW: 380,
      bottomH: 140,
      foldedSides: [],
    };
    localStorage.setItem('drey.dock', JSON.stringify(saved));
  });
}

test.use({
  seedVault: seed,
  launchArgs: ['--force-device-scale-factor=1'],
  appConfig: { plugins: { disabled: ['sample', 'templates', 'browser', 'drawio', 'ocr', 'meeting'] }, spellcheck: { enabled: false }, widgets: { disabled: ['windows', 'tickets-capacity'] } },
});

test.beforeEach(({ vaultDir }) => {
  // The Work panel's footer warns about a vault without git; the board has none.
  execFileSync('git', ['init', '-q'], { cwd: vaultDir, windowsHide: true });
});

test('board 7k: the Persona page', async ({ page, electronApp }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(OUT, { recursive: true });
  await sizeWindow(electronApp);
  await expect(page.locator('app-titlebar [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(500);
  await arrangeDocks(page);
  await page.reload();
  await sizeWindow(electronApp);
  await expect(page.locator('app-titlebar [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const panel = page.locator('.tickets-panel').filter({ visible: true });
  await expect(panel.locator('.work-row[data-id="T-0121"]')).toBeVisible({ timeout: 30_000 });
  await pushFleet(electronApp);

  const openFromMenu = async (label: string): Promise<void> => {
    await page.locator('app-panel-frame', { has: page.locator('.tickets-panel') }).filter({ visible: true }).locator('.head').hover();
    await page.locator('button[aria-label="More actions"]:visible').click({ force: true });
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };
  await page.keyboard.press('Control+Alt+B');
  await openFromMenu('Board');
  await expect(page.locator('.desk-board').filter({ visible: true })).toBeVisible({ timeout: 15_000 });
  await openFromMenu('Crew');
  await page.locator('.desk-team [data-persona="ben"]').first().click();
  await page.locator('.desk-detail-head .persona-edit-btn').click();
  await expect(page.locator('.persona-page .persona-text')).toBeVisible({ timeout: 15_000 });
  const crewTab = page.locator('app-tab-bar .tab', { hasText: 'Crew' }).first();
  await crewTab.hover();
  await crewTab.locator('button').last().click();
  // The board shows Board and the persona tab only; today's daily note may have opened by itself.
  const strayTab = page.locator('app-tab-bar .tab', { hasText: '.md' });
  while ((await strayTab.count()) > 0) {
    await strayTab.first().hover();
    await strayTab.first().locator('button').last().click();
  }
  await page.locator('app-tab-bar .tab', { hasText: 'persona' }).first().click();
  await expect(page.locator('.persona-page .persona-friction')).toBeVisible({ timeout: 15_000 });
  // The layout is the view's saved one: no changed dot on the view tab.
  await page.locator('app-view-switcher .vs-layout').click();
  await page.getByRole('menuitem', { name: /^Save/ }).first().click();
  await page.mouse.move(700, 880);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'DeskPersona.png') });
});
