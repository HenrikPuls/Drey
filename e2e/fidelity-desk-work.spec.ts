import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from './fixtures/drey';

/**
 * NOT a regression suite: puts the built app in the states of boards 7a
 * (DeskWork), 7e (DeskBoard), 7f (DeskTeam), 7h (DeskViews) and 7i (DeskTabs) and takes the screenshots the fidelity
 * checklist asks for. Opt-in, so CI skips it:
 *
 *   . .\env.ps1
 *   $env:DREY_FIDELITY_SHOTS = '1'
 *   npm run e2e:run -- fidelity-desk-work
 *
 * Output: `test-results/fidelity/<Board>.png` (1440x900, scale factor 1),
 * to load into `docs/design/work-panel/boards/compare.html`. The vault is
 * English; the sample data matches the boards' where the engine allows.
 */

const RUN = !!process.env['DREY_FIDELITY_SHOTS'];
test.skip(!RUN, 'set DREY_FIDELITY_SHOTS=1 -- the screenshots of boards 7a, 7e, 7f, 7h, 7i');

const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

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

const OUT = path.resolve(__dirname, '..', 'test-results', 'fidelity');
const WIDTH = 1440;
const HEIGHT = 900;

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: shaping, title: Shaping, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: build, title: Building, handover: agent build-default, persona: ben }',
  '  - { id: ready, title: Ready to try, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

function ticket(id: string, title: string, phase: string, extra: string[] = [], body = ''): string {
  return [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    'repo: drey',
    'priority: normal',
    `branch: t/${id}`,
    "entered-inbox: '2026-10-20T09:00:00Z'",
    ...(phase === 'inbox' ? [] : [`entered-${phase}: '2026-10-30T09:00:00Z'`]),
    ...extra,
    '---',
    '',
    '## Description',
    '',
    body === '' ? `${title} - what the owner wants, in two sentences.` : body,
    '',
    '## Log',
    '',
  ].join('\n');
}

function persona(title: string, role: string, color: string, budget: number): string {
  return ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: qwen3-coder', '  pool: [qwen3-coder]', '  router: off', `color: '${color}'`, 'skills: []', `budget: ${budget}`, '---', `Who ${title} is.`, ''].join('\n');
}

const now = new Date();
const settled = (ticketId: string, personaId: string, cost: number): string =>
  JSON.stringify({ v: 1, ts: now.toISOString(), event: 'run_settled', ticket: ticketId, persona: personaId, model: 'qwen3-coder', tokensIn: 40_000, tokensOut: 3_000, cost });

const PLAN_TICKET = ticket('T-0130', 'Voice capture for tickets', 'shaping').replace(
  '## Log',
  ['## Plan', '', '### Parts', '', '- [ ] Capture hotkey', '  persona: ben', '- [ ] Dictation hand-off', '  persona: ben', '- [ ] Ticket from transcript', '  persona: ben', '', '## Log'].join('\n'),
);

const seed: Record<string, string> = {
  'tickets/_meta/pipeline.md': PIPELINE,
  'tickets/_meta/repos.md': REPOS,
  'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#f2d3e2', 3),
  'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#8ecbef', 5),
  'tickets/_meta/personas/ralf/persona.md': persona('Ralf', 'reviewer', '#bfe3cd', 4),
  'tickets/_meta/personas/tessa/persona.md': persona('Tessa', 'tester', '#f2cfae', 7),
  'tickets/_meta/ledger.jsonl': [settled('T-0121', 'ben', 1.2), settled('T-0126', 'ben', 2.05), settled('T-0130', 'paul', 0.61), settled('T-0126', 'tessa', 0.36), settled('T-0118', 'tessa', 1.84), ''].join('\n'),
  'tickets/10-inbox/T-0133.md': ticket('T-0133', 'Sync status in the title bar', 'inbox'),
  'tickets/10-inbox/T-0132.md': ticket('T-0132', 'Backlinks: unlinked mentions', 'inbox'),
  'tickets/10-inbox/T-0131.md': ticket('T-0131', 'Dark mode for the PDF export', 'inbox'),
  'tickets/10-inbox/T-0129.md': ticket('T-0129', 'Calendar week numbers', 'inbox'),
  'tickets/20-shaping/T-0130.md': PLAN_TICKET,
  'tickets/20-shaping/T-0119.md': ticket('T-0119', 'Weekly security audit run', 'shaping'),
  'tickets/30-prioritized/T-0127.md': ticket('T-0127', 'Spellcheck: add French dictionary', 'prioritized'),
  'tickets/30-prioritized/T-0128.md': ticket('T-0128', 'Tag rename keeps pill colors', 'prioritized'),
  'tickets/40-build/T-0121.md': ticket('T-0121', 'Outline: drag headings to reorder', 'build', [], 'Drag headings in the Outline panel to reorder the note. The text under a heading is part of the move.'),
  'tickets/40-build/T-0126.md': ticket('T-0126', 'Git panel: stage single hunks', 'build'),
  'tickets/40-build/T-0122.md': ticket('T-0122', 'Win+H dictation hand-off', 'build'),
  'tickets/50-ready/T-0118.md': ticket('T-0118', 'Palette opens twice on slow CI', 'ready'),
  'tickets/60-done/T-0115.md': ticket('T-0115', 'Tag rename keeps descendants', 'done'),
  'tickets/60-done/T-0112.md': ticket('T-0112', 'Spellcheck: German dictionary', 'done'),
  'tickets/60-done/T-0110.md': ticket('T-0110', 'Settings: shortcut conflicts', 'done'),
  'projects/Outline ideas.md': '# Outline ideas\n\nReordering sections.\n',
  '2026-11-04.md': '# 2026-11-04\n\nA daily note.\n',
};

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
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.getURL().startsWith('app://')) {
        win.setContentSize(size.width, size.height);
      }
    }
  }, { width: WIDTH, height: HEIGHT });
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.mouse.move(700, 880);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    // A forced click on a hover-only control scrolls its dock sideways; the boards never are.
    for (const el of document.querySelectorAll<HTMLElement>('app-dock, app-dock *')) {
      if (el.scrollLeft > 0) {
        el.scrollLeft = 0;
      }
    }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

test.use({
  seedVault: seed,
  launchArgs: ['--force-device-scale-factor=1'],
  appConfig: {
    plugins: { disabled: ['sample', 'templates', 'browser', 'drawio', 'ocr', 'meeting'] },
    spellcheck: { enabled: false },
    llm: { enabled: true, provider: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: null, model: 'glm-5.3-flash' },
  },
});

/**
 * The boards' arrangement of the docks in the active view: the ids come
 * from the strips, by the panel's name; `shown` are the open panels,
 * `folded` the ones whose header is collapsed.
 */
async function arrangeDocks(page: Page, a: { left: string[]; right: string[]; bottom: string[]; shown: string[]; folded: string[]; rightW: number; bottomH?: number }): Promise<void> {
  await page.evaluate((arrangement) => {
    const ids = new Map<string, string>();
    for (const btn of document.querySelectorAll<HTMLElement>('app-dock-strip button[data-widget]')) {
      ids.set((btn.getAttribute('title') ?? '').split(' · ')[0], btn.dataset['widget'] ?? '');
    }
    const named = (names: string[]): string[] => names.map((n) => ids.get(n)).filter((id): id is string => id !== undefined);
    const left = named(arrangement.left);
    const right = named(arrangement.right);
    const bottom = named(arrangement.bottom);
    const shown = new Set(named(arrangement.shown));
    const saved = JSON.parse(localStorage.getItem('drey.dock') ?? '{}') as { active: string; views: Record<string, Record<string, unknown>> };
    const view = saved.views[saved.active];
    const all = [...ids.values()];
    const rest = all.filter((id) => !left.includes(id) && !right.includes(id) && !bottom.includes(id));
    saved.views[saved.active] = {
      ...view,
      dock: { left: left.concat(rest), right, bottom },
      open: Object.fromEntries(all.map((id) => [id, shown.has(id)])),
      flexes: Object.fromEntries(all.map((id) => [id, 1])),
      collapsed: Object.fromEntries(named(arrangement.folded).map((id) => [id, true])),
      leftW: 300,
      rightW: arrangement.rightW,
      bottomH: arrangement.bottomH ?? 280,
      foldedSides: [],
    };
    localStorage.setItem('drey.dock', JSON.stringify(saved));
  }, a);
}

/** Opens a vault file in a tab through the quick switcher. */
async function openFile(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Control+P');
  await page.locator('.palette input').fill(name);
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}

const WORK_DOCKS = {
  left: ['Calendar', 'Files', 'Backlinks', 'Source control', 'Outline', 'Tasks', 'Tickets'],
  right: ['Search', 'Assistant'],
  bottom: ['Capacity'],
  folded: ['Search'],
  rightW: 380,
  bottomH: 140,
};

async function reloadSized(page: Page, app: ElectronApplication): Promise<void> {
  await page.reload();
  await sizeWindow(app);
  await expect(page.locator('app-titlebar [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
}

test('boards 7a 7e 7f 7h 7i: the desk screens', async ({ page, electronApp }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(OUT, { recursive: true });
  await sizeWindow(electronApp);
  await expect(page.locator('app-titlebar [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // 7h: the Notes view, Files and the Assistant, the Layout menu open.
  await page.keyboard.press('Control+1');
  await page.waitForTimeout(500);
  await arrangeDocks(page, { left: ['Calendar', 'Files', 'Backlinks', 'Source control', 'Outline', 'Tasks', 'Tickets', 'Open windows'], right: ['Search', 'Assistant'], bottom: [], shown: ['Files', 'Assistant'], folded: ['Search'], rightW: 380 });
  await reloadSized(page, electronApp);
  await openFile(page, 'Outline ideas');
  await openFile(page, '2026-11-04');
  await page.locator('app-view-switcher .vs-layout').click();
  await shoot(page, 'DeskViews');
  await page.keyboard.press('Escape');
  await page.locator('app-view-switcher .ctx-backdrop').click({ force: true }).catch(() => undefined);

  // The Work view: 7a with the T-0121 tab, the Board and a note beside it.
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(500);
  await arrangeDocks(page, { ...WORK_DOCKS, shown: ['Tickets', 'Assistant', 'Capacity'] });
  await reloadSized(page, electronApp);
  const panel = page.locator('.tickets-panel').filter({ visible: true });
  await expect(panel.locator('.work-row[data-id="T-0121"]')).toBeVisible({ timeout: 30_000 });
  await pushFleet(electronApp);
  await page.waitForTimeout(800);

  const openFromMenu = async (label: string): Promise<void> => {
    await page.locator('button[aria-label="More actions"]:visible').click({ force: true });
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };
  await openFromMenu('Board');
  await expect(page.locator('.desk-board').filter({ visible: true })).toBeVisible({ timeout: 15_000 });
  await openFile(page, '2026-11-04');
  await panel.locator('.work-row[data-id="T-0121"]').click();
  await page.waitForTimeout(1200);
  await shoot(page, 'DeskWork');
  // The board forces the header's hover actions on; shown here for real.
  await page.locator('app-panel-frame', { has: page.locator('.tickets-panel') }).locator('.head').hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'DeskWork.header-hover.png'), clip: { x: 0, y: 78, width: 300, height: 36 } });

  // Boards 7e and 7f work with the right dock folded away.
  await page.keyboard.press('Control+Alt+B');
  await page.locator('app-tab-bar .tab', { hasText: 'Board' }).first().click();
  await expect(page.locator('.desk-capacity').filter({ visible: true })).toBeVisible({ timeout: 15_000 });
  await shoot(page, 'DeskBoard');

  await openFromMenu('Crew');
  await expect(page.locator('.desk-team').filter({ visible: true })).toBeVisible({ timeout: 15_000 });
  await page.locator('.desk-team [data-persona="ben"]').first().click();
  await shoot(page, 'DeskTeam');

  // 7i: the Open windows panel in the Notes view.
  await page.keyboard.press('Control+Alt+B');
  await page.keyboard.press('Control+1');
  await page.waitForTimeout(500);
  await arrangeDocks(page, { left: ['Calendar', 'Files', 'Backlinks', 'Source control', 'Outline', 'Tasks', 'Tickets', 'Open windows'], right: ['Search', 'Assistant'], bottom: [], shown: ['Open windows', 'Assistant'], folded: ['Search'], rightW: 380 });
  await reloadSized(page, electronApp);
  await shoot(page, 'DeskTabs');
});
