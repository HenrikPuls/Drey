import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from './fixtures/drey';
import { renderVerificationSection } from '../packages/tickets-engine/src/core/verification';
import { renderVerlaufLine } from '../packages/tickets-engine/src/core/verlauf';

/**
 * NOT a regression suite: puts the built app in the states boards 7b, 7c, 7d,
 * 7j and the ticket card of 9a show, on a scratch dricket store (the owner's
 * backend), and takes the screenshots of the fidelity checklist. Opt-in:
 *
 *   . .\env.ps1
 *   $env:DREY_FIDELITY_SHOTS = '1'
 *   npm run e2e:run -- fidelity-desk-tickets
 *
 * Output: `test-results/fidelity/<Board>.png` at 1440x900, scale factor 1, for
 * `docs/design/work-panel/boards/compare.html`. DREY_FIDELITY_PREFIX prefixes
 * the file names (`before-`). The seeded text is the board's English; the ids
 * and the store paths are the scratch store's (data, not layout).
 */
const RUN = !!process.env['DREY_FIDELITY_SHOTS'];
const PREFIX = process.env['DREY_FIDELITY_PREFIX'] ?? '';
const bin = process.env['DREY_DK_BIN'] ?? 'dk';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkf-'));
const home = path.join(root, 'home');
const storeDir = path.join(root, 's');
const dataDir = path.join(root, 'd');
const codeRepo = path.join(root, 'code', 'drey');
const worktrees = path.join(root, 'code', 'wt');
fs.mkdirSync(home, { recursive: true });
process.env['USERPROFILE'] = home;
process.env['HOME'] = home;
process.env['DK_OWNER'] = 'henrik';
process.env['GIT_AUTHOR_NAME'] = 'Store Test';
process.env['GIT_AUTHOR_EMAIL'] = 'store@test.invalid';
process.env['GIT_COMMITTER_NAME'] = 'Store Test';
process.env['GIT_COMMITTER_EMAIL'] = 'store@test.invalid';

const OUT = path.resolve(__dirname, '..', 'test-results', 'fidelity');

const dk = (args: string[]): string =>
  execFileSync(bin, args, {
    cwd: fs.existsSync(storeDir) ? storeDir : root,
    env: { ...process.env, DK_OWNER: 'terminal', DK_STORE: storeDir, DK_DATA_DIR: dataDir },
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  });
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
};

/** Writes the ticket's body and extension fields over `dk put`. */
function seedTicket(n: number, fields: Record<string, string>, body: readonly string[]): void {
  const file = path.join(storeDir, 'tickets', 't', '0000', `t-${n}`, 'ticket.md');
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const head = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const rev = /^rev:\s*(\d+)/m.exec(text)?.[1] ?? '0';
  const kept = head.split('\n').filter((line) => !Object.keys(fields).some((key) => line.startsWith(`${key}:`)));
  const extra = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  const put = path.join(root, `put-${n}.md`);
  fs.writeFileSync(put, `---\n${[...kept, ...extra].join('\n')}\n---\n\n${body.join('\n')}\n`);
  dk(['put', `t-${n}`, '-F', put, '--claim', '--if-version', rev]);
}

const VERLAUF = [
  renderVerlaufLine({ phase: 'plan', persona: 'paul', model: 'Claude sonnet', tokens: '21k', cost: 0.31, dauer: '4m', ausgang: 'handed-over' }),
  renderVerlaufLine({ phase: 'build', persona: 'ben', model: 'Claude sonnet', tokens: '88k', cost: 0.94, dauer: '14m', ausgang: 'handed-over' }),
  renderVerlaufLine({ phase: 'review', persona: 'ralf', model: 'Claude sonnet', tokens: '30k', cost: 0.32, dauer: '5m', ausgang: 'handed-over' }),
  renderVerlaufLine({ phase: 'test', persona: 'tessa', model: 'Claude sonnet', tokens: '24k', cost: 0.27, dauer: '6m', ausgang: 'handed-over' }),
];

function seedStore(): void {
  dk(['init', storeDir, 't']);
  git(storeDir, 'checkout', '-q', 'tickets');
  for (const title of ['A8 large modules', 'Voice capture for tickets', 'Voice capture parts', 'Palette opens twice on slow CI', 'Outline: drag headings to reorder']) {
    dk(['add', '--unclaimed', '-m', title]);
  }
  // 9a: Prioritized, the next step is one primary button.
  seedTicket(1, { 'x-phase': 'prioritized', repos: 'drey', priority: 'normal', 'x-worker': 'opencode' }, [
    '# A8 — large modules, when next touched',
    '',
    '## Description',
    '',
    'Behaviour-neutral slicing when they are next touched anyway (the roadmap: no milestone of its own): markdown-surface.ts, vault-manager.ts (vault registry apart from file operations; delete the sidecar plumbing), dock.service.ts and the assistant’s renderer/state.ts. This ticket is the reminder, not a standalone job.',
    '',
    'Source: roadmap “Architectural cleanup” A8.',
    '',
    '## Plan',
    '',
    'To be filled in the plan phase.',
    '',
    '## Acceptance criteria',
    '',
    'Executable checks as backticked checkbox lines; the machine gate runs them.',
    '',
    '## Log',
    '',
    "- '2026-10-20T09:00:00Z' owner — created",
    "- '2026-10-30T09:00:00Z' owner — inbox -> prioritized",
    "- '2026-10-30T09:05:00Z' owner — priority normal",
  ]);
  // 7b: Shaping.
  const plan = [
    '## Plan',
    '',
    '### Goal',
    '',
    'Press one global hotkey, speak, and get a ticket in the inbox. No window to manage, no typing.',
    '',
    '### Decisions',
    '',
    '- Windows dictation (Win+H) is the speech engine; Drey only opens the capture window and focuses it.',
    '- The first sentence becomes the title; the rest stays in the description.',
    '',
    '### Constraints',
    '',
    '- Nothing leaves the machine.',
    '- The hotkey is configurable (ADR-0073).',
    '',
  ];
  seedTicket(2, { 'x-phase': 'shaping', repos: 'drey', 'x-persona': 'paul' }, [
    ...plan,
    '### Open questions',
    '',
    '- How many parts does this need? Asked in Mission Control.',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] Hotkey raises Drey and opens the capture window with the caret in it',
    '- [ ] A spoken sentence ends up as one inbox ticket',
    '- [ ] Escape closes the window without creating anything',
    '',
    '## Verlauf',
    '',
    renderVerlaufLine({ phase: 'shape', persona: 'paul', model: 'Claude sonnet', tokens: '9k', cost: 0.34, dauer: '3m', ausgang: 'handed-over' }),
  ]);
  // 7c: the plan lists parts; the board's page shows the block right under the title.
  seedTicket(3, { 'x-phase': 'shaping', repos: 'drey', 'x-persona': 'paul' }, [
    '## Plan',
    '',
    '### Parts',
    '',
    '- [ ] Capture hotkey and window',
    '  persona: ben',
    '  reason: Mod+Alt+T, focus handling',
    '- [ ] Dictation hand-off (Win+H)',
    '  persona: ben',
    '  reason: needs the window',
    '- [ ] Ticket from transcript',
    '  persona: ben',
    '  reason: title from the first sentence',
    '',
    '## Verlauf',
    '',
    renderVerlaufLine({ phase: 'plan', persona: 'paul', model: 'Claude sonnet', tokens: '21k', cost: 0.61, dauer: '4m', ausgang: 'handed-over' }),
  ]);
  // 7j: Ready to try with proof and cost.
  seedTicket(4, { 'x-phase': 'ready', repos: 'drey' }, [
    '## Goal',
    '',
    'One Ctrl+P opens one palette, also when the machine is slow and the key repeats.',
    '',
    renderVerificationSection({
      testedAt: '2026-11-04T10:00:00Z',
      tester: 'Tessa',
      environment: 'Electron 34.2.0 on win32',
      criteria: [
        { command: 'One palette after a double Ctrl+P', passed: true, screenshot: 'verify-1.png', note: 'tessa' },
        { command: 'Escape closes it, the editor keeps focus', passed: true, screenshot: 'verify-2.png', note: 'tessa' },
        { command: 'A slow machine (throttled CPU) still opens one', passed: true, screenshot: null, note: 'tessa' },
      ],
      findings: [],
      video: 'walkthrough.webm',
      videoChapters: [
        { atMs: 12000, label: 'One palette after a double Ctrl+P' },
        { atMs: 24000, label: 'Escape closes it, the editor keeps focus' },
        { atMs: 41000, label: 'A slow machine (throttled CPU) still opens one' },
      ],
    }),
    '## Verlauf',
    '',
    ...VERLAUF,
  ]);
  // 7d: the Review tab of a ticket waiting on the owner.
  seedTicket(5, { 'x-phase': 'ready', repos: 'drey' }, [
    '## Goal',
    '',
    'Drag headings in the Outline panel to reorder a note, the text below a heading moves with it.',
    '',
    renderVerificationSection({
      testedAt: '2026-11-04T10:00:00Z',
      tester: 'Tessa',
      environment: 'Electron 34.2.0 on win32',
      criteria: [
        { command: 'Drag a heading', passed: true, screenshot: 'verify-1.png', note: null },
        { command: 'Undo once', passed: true, screenshot: 'verify-2.png', note: null },
        { command: 'Last heading', passed: true, screenshot: 'verify-3.png', note: null },
        { command: 'Empty selection', passed: true, screenshot: null, note: null },
      ],
      findings: [],
      video: 'walkthrough.webm',
      videoChapters: [
        { atMs: 6000, label: 'Drag a heading' },
        { atMs: 21000, label: 'Undo once' },
        { atMs: 35000, label: 'Last heading' },
      ],
    }),
    '## Verlauf',
    '',
    renderVerlaufLine({ phase: 'build', persona: 'ben', model: 'Claude sonnet', tokens: '48k', cost: 0.9, dauer: '9m', ausgang: 'handed-over' }),
    renderVerlaufLine({ phase: 'test', persona: 'tessa', model: 'Claude sonnet', tokens: '24k', cost: 0.3, dauer: '6m', ausgang: 'handed-over' }),
  ]);

  fs.mkdirSync(path.join(codeRepo, 'plugins', 'outline', 'renderer'), { recursive: true });
  git(codeRepo, 'init', '-q', '-b', 'main');
  const dir = path.join(codeRepo, 'plugins', 'outline', 'renderer');
  fs.writeFileSync(path.join(dir, 'drag.ts'), [
    'function onDrop(event: DragEvent, tree: OutlineTree): void {',
    '  const target = tree.nodeAt(event.clientY);',
    '  tree.moveHeading(source, target);',
    '  view.dispatch({ effects: refresh.of(null) });',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'tree.ts'), 'export const a = 1;\nexport const b = 2;\n');
  git(codeRepo, 'add', '.');
  git(codeRepo, '-c', 'user.name=T', '-c', 'user.email=t@test.invalid', 'commit', '-q', '-m', 'base');
  fs.mkdirSync(worktrees, { recursive: true });
  const wt = path.join(worktrees, 'T-0005');
  git(codeRepo, 'worktree', 'add', '-q', '-b', 't/T-0005', wt, 'main');
  const wdir = path.join(wt, 'plugins', 'outline', 'renderer');
  fs.writeFileSync(path.join(wdir, 'drag.ts'), [
    'function onDrop(event: DragEvent, tree: OutlineTree): void {',
    '  const target = tree.nodeAt(event.clientY);',
    '  const range = tree.sectionRange(source);',
    '  if (range === null) { return; }',
    '  tree.moveRange(range, target, { withBody: !event.altKey });',
    '  view.dispatch({ effects: refresh.of(null) });',
    '}',
    'function sectionDepth(node: OutlineNode): number {',
    '  return node.level - tree.minLevel;',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(wdir, 'tree.ts'), 'export const a = 1;\nexport const b = 3;\nexport const c = 4;\n');
  fs.writeFileSync(path.join(wdir, 'drag.spec.ts'), "import { it } from 'vitest';\nit('moves a section', () => undefined);\n");
  git(wt, 'add', '.');
  git(wt, '-c', 'user.name=T', '-c', 'user.email=t@test.invalid', 'commit', '-q', '-m', 'drag sections');
}

function stopEngine(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(home, '.drey-engine', 'service.lock'), 'utf8')) as { pid?: number };
    if (typeof lock.pid === 'number') {
      process.kill(lock.pid);
    }
  } catch {
    // no engine was started, or it is already gone
  }
}

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: shaping, title: Shaping, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, persona: paul }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben, claim: true }',
  '  - { id: review, title: Review, handover: agent review-default, persona: ralf }',
  '  - { id: test, title: Test, handover: agent test-default, persona: tessa }',
  '  - { id: ready, title: Ready to try, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const persona = (title: string, role: string, color: string): string =>
  ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: sonnet', '  pool: [sonnet]', '  router: off', `color: '${color}'`, 'skills: []', '---', '', `Who ${title} is.`, ''].join('\n');

test.skip(!RUN, 'set DREY_FIDELITY_SHOTS=1 -- the boards 7b, 7c, 7d, 7j screenshots');
test.beforeAll(() => {
  if (RUN) {
    seedStore();
  }
});
test.afterEach(() => stopEngine());
test.afterAll(() => {
  stopEngine();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // The engine holds files open for a moment after the kill; a leftover temp dir is harmless.
  }
});

test.use({
  launchArgs: ['--force-device-scale-factor=1'],
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', `    path: ${JSON.stringify(codeRepo)}`, `    worktrees: ${JSON.stringify(worktrees)}`, '---', ''].join('\n'),
    'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#a78bfa'),
    'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#6fa58f'),
    'tickets/_meta/personas/ralf/persona.md': persona('Ralf', 'reviewer', '#c9a25a'),
    'tickets/_meta/personas/tessa/persona.md': persona('Tessa', 'tester', '#c0706a'),
  },
  appConfig: {
    plugins: { disabled: ['sample', 'templates', 'browser', 'drawio', 'ocr', 'meeting'] },
    spellcheck: { enabled: false },
    widgets: { disabled: ['windows', 'tickets-capacity'] },
    llm: { enabled: true, provider: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: null, model: 'glm-5.3-flash' },
  },
});

test.beforeEach(({ userDataDir }) => {
  const dir = path.join(userDataDir, 'plugins', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ backend: 'dricket', 'dk.store': storeDir, 'dk.dataDir': dataDir, 'dk.syncSeconds': 0 }, null, 2));
});

/** Row 7's arrangement of the Work view: Tickets alone on the left, Search folded above the Assistant on the right. */
async function arrangeDocks(page: Page, layout: { readonly shown: readonly string[]; readonly collapsed: readonly string[]; readonly rightW: number }): Promise<void> {
  await page.evaluate((wanted) => {
    const ids = new Map<string, string>();
    for (const btn of document.querySelectorAll<HTMLElement>('app-dock-strip button[data-widget]')) {
      ids.set((btn.getAttribute('title') ?? '').split(' · ')[0] ?? '', btn.dataset['widget'] ?? '');
    }
    const named = (names: string[]): string[] => names.map((n) => ids.get(n)).filter((id): id is string => id !== undefined);
    const left = named(['Calendar', 'Files', 'Backlinks', 'Source control', 'Outline', 'Tickets']);
    const right = named(['Find', 'Work', 'Assistant']);
    const shown = new Set(named([...wanted.shown]));
    const saved = JSON.parse(localStorage.getItem('drey.dock') ?? '{}') as { active: string; views: Record<string, Record<string, unknown>> };
    const view = saved.views[saved.active];
    const all = [...ids.values()];
    const rest = all.filter((id) => !left.includes(id) && !right.includes(id));
    saved.views[saved.active] = {
      ...view,
      dock: { left: left.concat(rest), right, bottom: [] },
      open: Object.fromEntries(all.map((id) => [id, shown.has(id)])),
      flexes: Object.fromEntries(all.map((id) => [id, 1])),
      collapsed: Object.fromEntries(named([...wanted.collapsed]).map((id) => [id, true])),
      leftW: 300,
      rightW: wanted.rightW,
      foldedSides: [],
    };
    localStorage.setItem('drey.dock', JSON.stringify(saved));
  }, layout);
}

const ROW_7 = { shown: ['Tickets', 'Work', 'Find', 'Assistant'], collapsed: ['Find'], rightW: 380 };
const BOARD_9A = { shown: ['Calendar', 'Files', 'Outline', 'Find', 'Assistant'], collapsed: ['Find'], rightW: 420 };

async function sizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.getURL().startsWith('app://')) {
        win.setContentSize(1440, 900);
      }
    }
  });
}

/**
 * Board 7b's marks: a Shaping conversation is not run here, so the plan status
 * the engine would answer after Paul's turn and an owner edit is answered here.
 */
async function markPlan(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers.get('plugin:invoke');
    if (original === undefined) {
      throw new Error('no plugin:invoke handler');
    }
    handlers.set('plugin:invoke', (event, ...args) => {
      const text = JSON.stringify(args);
      // The history behind the estimates: three runs each, as the boards state them.
      if (text.includes('"estimate"') && text.includes('"ben"')) {
        return { estimate: { gate: 'build', persona: 'ben', model: '', runs: 3, cost: 1.4, costLow: 1.1, costHigh: 1.8, minutes: 12, tokens: 40000 } };
      }
      if (text.includes('"estimate"') && text.includes('"tessa"')) {
        return { estimate: { gate: 'test', persona: 'tessa', model: '', runs: 3, cost: 1.9, costLow: 1.5, costHigh: 2.4, minutes: 12, tokens: 40000 } };
      }
      if (text.includes('mcPlanStatus') && text.includes('T-0002')) {
        return {
          ok: true,
          version: 2,
          modelAt: new Date(Date.now() - 120_000).toISOString(),
          edits: 1,
          summary: '1 edit',
          marks: [
            { no: 8, text: '- Windows dictation (Win+H) is the speech engine; Drey only opens the capture window and focuses it.', by: 'model' },
            { no: 9, text: '- The first sentence becomes the title; the rest stays in the description.', by: 'you' },
          ],
        };
      }
      return original(event, ...args);
    });
  });
}

async function openTicket(page: Page, id: string): Promise<void> {
  const panel = page.locator('.tickets-panel').filter({ visible: true });
  await expect(panel.locator('.work-row').first()).toBeVisible({ timeout: 30_000 });
  const row = panel.locator(`.work-row[data-id="${id}"]`);
  // A plain group shows two rows and "<n> more" (milestone 194); the fold is remembered, so only when needed.
  if ((await row.count()) === 0) {
    for (const more of await panel.locator('.work-ideas-more', { hasText: 'more' }).all()) {
      await more.click();
    }
  }
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click({ button: 'right' });
  await page.getByText('Open ticket', { exact: true }).first().click();
  await expect(page.locator('app-editor .tickets-head').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.mouse.move(700, 880);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${PREFIX}${name}.png`) });
}

/** Checklist step 9: boards/compare.html over board and screenshot, one capture per mode. */
async function compareWithBoard(app: ElectronApplication, name: string): Promise<void> {
  const boards = path.resolve(__dirname, '..', 'docs', 'design', 'work-panel', 'boards');
  const url = pathToFileURL(path.join(boards, 'compare.html'));
  url.searchParams.set('board', pathToFileURL(path.join(boards, `${name}.png`)).href);
  url.searchParams.set('shot', pathToFileURL(path.join(OUT, `${PREFIX}${name}.png`)).href);
  const opened = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = new BrowserWindow({ width: 1500, height: 1000, show: false });
    void win.loadURL(target);
  }, url.href);
  const compare = await opened;
  await compare.waitForLoadState('load');
  await compare.waitForTimeout(500);
  for (const mode of ['overlay', 'diff']) {
    await compare.locator(`[data-mode="${mode}"]`).click();
    await compare.waitForTimeout(300);
    await compare.locator('#stage').screenshot({ path: path.join(OUT, `${PREFIX}${name}.${mode}.png`) });
  }
  await compare.close();
}

/** Opens the Work view in a layout, at the board's size. */
async function workView(page: Page, app: ElectronApplication, layout: Parameters<typeof arrangeDocks>[1]): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (() => Promise.resolve({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(400);
  await arrangeDocks(page, layout);
  await page.reload();
  await sizeWindow(app);
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await markPlan(app);
}

test('board 9a: the ticket card of a Prioritized ticket', async ({ page, electronApp }) => {
  test.setTimeout(180_000);
  fs.mkdirSync(OUT, { recursive: true });
  await workView(page, electronApp, BOARD_9A);
  const id = await electronApp.evaluate(() => 'T-0001');
  await page.locator('app-dock-strip button[aria-label="Show Tickets"]').click();
  await openTicket(page, id);
  await page.locator('app-dock-strip button[aria-label="Hide Tickets"]').click();
  await page.locator('app-editor .chrome app-markdown-toolbar button[aria-label="Unpin formatting toolbar"]').first().click();
  await shoot(page, 'DeskClean');
  await compareWithBoard(electronApp, 'DeskClean');
});

test('boards 7b, 7c, 7d, 7j', async ({ page, electronApp }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(OUT, { recursive: true });
  await workView(page, electronApp, ROW_7);

  await openTicket(page, 'T-0002');
  await shoot(page, 'DeskShape');
  await compareWithBoard(electronApp, 'DeskShape');
  await page.locator('app-editor .chrome app-markdown-toolbar button[aria-label="Unpin formatting toolbar"]').first().click();

  await openTicket(page, 'T-0003');
  await shoot(page, 'DeskPlan');
  await compareWithBoard(electronApp, 'DeskPlan');

  await openTicket(page, 'T-0004');
  await shoot(page, 'DeskReady');
  await compareWithBoard(electronApp, 'DeskReady');

  await openTicket(page, 'T-0005');
  await page.locator('app-editor').getByRole('button', { name: 'Open Review' }).first().click();
  const review = page.locator('.tickets-review').filter({ visible: true });
  await expect(review).toBeVisible({ timeout: 15_000 });
  await expect(review.locator('.tickets-review-row').first()).toBeVisible({ timeout: 20_000 });
  const dragTs = review.locator('.tickets-review-file', { hasText: 'drag.ts' }).first();
  await dragTs.click();
  await dragTs.locator('input').check();
  for (const [line, text] of [
    [4, 'What happens with an empty selection? I would expect nothing to move.'],
    [9, 'Name this after what it returns, not how it is computed.'],
  ] as const) {
    await review.locator(`button[aria-label="Comment on line ${line}"]`).click();
    await review.locator('.tickets-review-input').fill(text);
    await page.keyboard.press('Control+Enter');
  }
  await shoot(page, 'DeskReview');
  await compareWithBoard(electronApp, 'DeskReview');
});
