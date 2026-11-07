import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, type ElectronApplication, type Page } from './fixtures/drey';

/**
 * NOT a regression suite: puts the built app in the states of boards 9a
 * (DeskClean), 7a (DeskWork), 7c (DeskPlan) and 7d (DeskReview) -- the right
 * dock, the Assistant panel -- and takes the screenshots the fidelity
 * checklist asks for. Opt-in, so CI skips it:
 *
 *   . .\env.ps1
 *   $env:DREY_FIDELITY_SHOTS = '1'
 *   npm run e2e:run -- fidelity-desk-assistant
 *
 * Output: `test-results/fidelity/<Board>.Assistant.png` (1440x900, scale
 * factor 1), to load into `docs/design/work-panel/boards/compare.html`.
 * The vault is English; the mock model's answers stand in for the engine's.
 */

const RUN = !!process.env['DREY_FIDELITY_SHOTS'];
test.skip(!RUN, 'set DREY_FIDELITY_SHOTS=1 -- the Assistant screenshots of boards 9a, 7a, 7c, 7d');

const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

const OUT = path.resolve(__dirname, '..', 'test-results', 'fidelity');
const WIDTH = 1440;
const HEIGHT = 900;
const PORT = 41873;

type Scenario = 'work' | 'plan' | 'review';
let scenario: Scenario = 'work';

const ENVELOPES: Record<Scenario, Record<string, unknown>> = {
  work: {
    say: 'Both are queued. Ben is on **T-0121**, step 2 of 4, and has one question for you.',
    question: {
      text: 'One decision before Ben goes on: **should dragging a heading also move the text below it?**',
      options: [
        { label: 'Move the whole section', recommended: true },
        { label: 'Only the heading line', recommended: false },
        { label: 'Section; Alt-drag for the line only', recommended: false },
      ],
    },
  },
  plan: {
    say: 'Paul split the idea into **3 parts**. Estimates come from your own history: two are known, one is a first run.',
    question: {
      text: 'The plan is ready. **Accept it as it stands?**',
      options: [
        { label: 'Accept plan', recommended: true },
        { label: 'Change something first', recommended: false },
      ],
    },
  },
  review: { say: 'Ralf reviewed **3 files**, nothing blocking.' },
};

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'glm-5.3-flash' }] }));
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    const answer = JSON.stringify(ENVELOPES[scenario]);
    if (body['stream'] === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '' }, null));
      res.write(chunk({ content: answer }, null));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
});

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

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

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  stopEngine();
  fs.rmSync(engineHome, { recursive: true, force: true });
});

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: ideas, title: Ideas, handover: manual }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

const persona = (title: string, role: string, color: string): string =>
  ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: glm-5.3-flash', '  pool: [glm-5.3-flash]', '  router: off', `color: '${color}'`, 'skills: []', 'budget: 3', '---', '', `Who ${title} is.`, ''].join('\n');

function ticket(id: string, title: string, phase: string, body: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    'repo: drey',
    'priority: normal',
    ...(phase === 'ideas' ? ['rank: 5000'] : [`branch: t/${id}`, "entered-inbox: '2026-10-20T09:00:00Z'"]),
    '---',
    '',
    '## Description',
    '',
    body,
    '',
    '## Plan',
    '',
    '## Log',
    '',
    "- '2026-11-04T09:00:00Z' owner — created",
    '',
  ].join('\n');
}

const T0017 = ticket('T-0017', 'A8 large modules', 'prioritized', 'Behaviour-neutral slicing when they are next touched anyway.');

const CHAT = [
  '---',
  'kind: chat',
  'provider: openai-compat',
  'model: glm-5.3-flash',
  'note: v-main::tickets/20-build/T-0017.md',
  'title: Beginning and end as a perspective question',
  '---',
  '',
  '## User — 2026-11-06T22:10:40',
  '',
  '"... just as real and fixed as the Big Bang; it is simply positioned elsewhere." What does that mean?',
  '',
  '[[the time - a short story.md]]',
  '',
  '## Assistant — 2026-11-06T22:11:00',
  '<!-- drey: {"durationMs":20000,"model":"glm-5.3-flash"} -->',
  '',
  'The paragraph spells out the central idea of the story: the difference between beginning and end is not a property of time itself but of our point of view.',
  '',
  '**The human perspective:** We experience ourselves in the middle of a river. The beginning lies behind us, known and unchangeable. The end lies ahead, unknown.',
  '',
  '**The block-universe perspective:** Seen as a static landscape, time loses the contrast. Beginning and end are two places in the same space.',
  '',
  '```drey-context',
  ...[1, 2, 3, 4].map((line) => JSON.stringify({ cite: { path: 'the time - a short story.md', heading: 'The time', line } })),
  '```',
  '',
].join('\n');

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#a78bfa'),
    'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#3b82f6'),
    'tickets/20-build/T-0017.md': T0017,
    'tickets/10-ideas/T-0121.md': ticket('T-0121', 'Outline: drag headings to reorder', 'ideas', 'Drag headings in the Outline panel to reorder the note.'),
    'tickets/10-ideas/T-0130.md': ticket('T-0130', 'Voice capture for tickets', 'ideas', 'Say a ticket instead of typing it.'),
    'the time - a short story.md': '# The time\n\nA story.\n',
    'chats/2026/11/2026-11-06-beginning-and-end.md': CHAT,
  },
  launchArgs: ['--force-device-scale-factor=1'],
  appConfig: {
    plugins: { disabled: ['sample', 'templates', 'browser', 'drawio', 'ocr', 'meeting'] },
    spellcheck: { enabled: false },
    widgets: { disabled: ['windows', 'tickets-capacity'] },
    llm: { enabled: true, provider: 'openai-compat', baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: null, model: 'glm-5.3-flash' },
    // The Web chip shows while a web tool is switched on (the boards draw it).
    tools: { webSearch: { enabled: true } },
  },
});

async function sizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.getURL().startsWith('app://')) {
        win.setContentSize(size.width, size.height);
      }
    }
  }, { width: WIDTH, height: HEIGHT });
}

/** The right dock as the boards draw it: Search folded above the open Assistant, 380 / 420 px wide. */
async function arrangeRight(page: Page, width: number): Promise<void> {
  await page.evaluate((rightW) => {
    const ids = new Map<string, string>();
    for (const btn of document.querySelectorAll<HTMLElement>('app-dock-strip button[data-widget]')) {
      ids.set((btn.getAttribute('title') ?? '').split(' · ')[0], btn.dataset['widget'] ?? '');
    }
    const named = (names: string[]): string[] => names.map((n) => ids.get(n)).filter((id): id is string => id !== undefined);
    const saved = JSON.parse(localStorage.getItem('drey.dock') ?? '{}') as { active: string; views: Record<string, Record<string, unknown>> };
    const view = saved.views[saved.active];
    const dock = view['dock'] as { left: string[]; right: string[]; bottom: string[] };
    const search = named(['Search', 'Tasks']);
    const assistant = named(['Assistant']);
    const open = { ...(view['open'] as Record<string, boolean>) };
    for (const id of [...named(['Search']), ...assistant, ...named(['Files'])]) {
      open[id] = true;
    }
    for (const id of named(['Tickets', 'Work'])) {
      open[id] = false;
    }
    saved.views[saved.active] = {
      ...view,
      dock: {
        ...dock,
        left: dock.left.filter((id) => !search.includes(id) && !assistant.includes(id)),
        right: [...search, ...assistant, ...dock.right.filter((id) => !search.includes(id) && !assistant.includes(id))],
      },
      open,
      collapsed: { ...(view['collapsed'] as object), ...Object.fromEntries(named(['Search']).map((id) => [id, true])), ...Object.fromEntries(assistant.map((id) => [id, false])) },
      rightW,
      foldedSides: [],
    };
    localStorage.setItem('drey.dock', JSON.stringify(saved));
  }, width);
}

async function openTicket(page: Page, folder: string, name: string): Promise<void> {
  const tree = page.locator('app-dock[side="left"]');
  if ((await tree.getByText(name, { exact: true }).count()) === 0) {
    if ((await tree.getByText(folder, { exact: true }).count()) === 0) {
      await tree.getByText('tickets', { exact: true }).first().click();
    }
    await tree.getByText(folder, { exact: true }).first().click();
  }
  await tree.getByText(name, { exact: true }).first().dblclick();
  await expect(page.locator('app-tab-bar .tab', { hasText: name.replace('.md', '') }).first()).toBeVisible({ timeout: 20_000 });
}

async function measure(page: Page, board: string): Promise<void> {
  const rects = await page.evaluate(() => {
    const out: Record<string, string> = {};
    const q: [string, string][] = [
      ['panel', 'app-panel-frame:has(.assistant-panel)'],
      ['head', '.assistant-head'],
      ['targets', '.assistant-targets'],
      ['label', '.assistant-head .chat-label'],
      ['thread', '.assistant-thread:not([hidden])'],
      ['tray', '.target-tray:not([hidden])'],
      ['composer', '.assistant-composer'],
      ['box', '.assistant-composer .composer-box'],
      ['meta', '.assistant-composer .composer-meta'],
      ['send', '.assistant-composer .send'],
    ];
    for (const [key, sel] of q) {
      const el = document.querySelector(sel);
      if (el === null) {
        out[key] = 'absent';
        continue;
      }
      const r = el.getBoundingClientRect();
      out[key] = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    }
    return out;
  });
  console.log(board, JSON.stringify(rects));
}

async function ready(page: Page, app: ElectronApplication, width = 380): Promise<void> {
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(400);
  await arrangeRight(page, width);
  await page.reload();
  await sizeWindow(app);
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
}

/** The boards draw the Vault chip pressed: the active vault is the context. */
async function vaultOn(page: Page): Promise<void> {
  const button = page.locator('.assistant-panel .composer-meta .vault');
  await button.click();
  await page.locator('.assistant-picker .assistant-picker-row', { hasText: 'Active vault' }).click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function send(page: Page, text: string): Promise<void> {
  const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
  await expect(panel.locator('.assistant-composer .chip.target-attached')).toBeVisible({ timeout: 20_000 });
  await panel.locator('.composer-input .cm-content').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(700, 500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(1200);
}

test('board 7a and 7c: Mission Control with a decision card', async ({ page, electronApp }) => {
  test.setTimeout(240_000);
  await ready(page, electronApp);
  await vaultOn(page);
  const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
  await expect(panel.locator('.assistant-targets .assistant-target').first()).toBeVisible({ timeout: 30_000 });

  scenario = 'work';
  await panel.locator('.assistant-targets').getByLabel(/Mission Control/).first().click();
  await openTicket(page, '10-ideas', 'T-0121.md');
  await page.waitForTimeout(500);
  await send(page, 'Ship the storage scout, then run the voice capture idea next.');
  await expect(panel.locator('.target-tray')).toBeVisible({ timeout: 60_000 });
  await settle(page);
  await measure(page, 'DeskWork');
  await page.screenshot({ path: path.join(OUT, 'DeskWork.Assistant.png') });
  await geometry(page, electronApp, 'DeskWork', 'DeskWork');
  await pairShot(electronApp, 'DeskWork', 'DeskWork.Assistant', 1060, 'DeskWork');
  await compareWithBoard(electronApp, 'DeskWork');

  scenario = 'plan';
  await panel.locator('.assistant-head .chat-new').click();
  await openTicket(page, '10-ideas', 'T-0130.md');
  await page.waitForTimeout(500);
  await send(page, 'Plan this idea.');
  await expect(panel.locator('.target-tray')).toContainText('The plan is ready', { timeout: 60_000 });
  await settle(page);
  await measure(page, 'DeskPlan');
  await page.screenshot({ path: path.join(OUT, 'DeskPlan.Assistant.png') });
  await geometry(page, electronApp, 'DeskPlan', 'DeskPlan');
  await pairShot(electronApp, 'DeskPlan', 'DeskPlan.Assistant', 1060, 'DeskPlan');
  await compareWithBoard(electronApp, 'DeskPlan');

  // Board 7d: the Review tab announces two line comments; the card offers Send back with them.
  scenario = 'review';
  await panel.locator('.assistant-head .chat-new').click();
  await openTicket(page, '10-ideas', 'T-0121.md');
  await send(page, 'Review this ticket.');
  await expect(panel.locator('.target-thread')).toContainText('Ralf reviewed', { timeout: 60_000 });
  await page.evaluate(() => {
    document.dispatchEvent(new CustomEvent('drey:tickets-review-comments', { detail: { id: 'T-0121', count: 2 } }));
  });
  await expect(panel.locator('.target-tray')).toContainText('Send back with 2 comments');
  await settle(page);
  await measure(page, 'DeskReview');
  await page.screenshot({ path: path.join(OUT, 'DeskReview.Assistant.png') });
  await geometry(page, electronApp, 'DeskReview', 'DeskReview');
  await pairShot(electronApp, 'DeskReview', 'DeskReview.Assistant', 1060, 'DeskReview');
  await compareWithBoard(electronApp, 'DeskReview');
});

test('board 9a: the Assistant with a chat about T-0017', async ({ page, electronApp }) => {
  test.setTimeout(120_000);
  await ready(page, electronApp, 420);
  await vaultOn(page);
  const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
  await openTicket(page, '20-build', 'T-0017.md');
  await panel.locator('.assistant-targets').getByLabel('Model', { exact: true }).click();
  await page.waitForTimeout(500);
  await panel.locator('.assistant-head .chat-switch').click();
  await panel.locator('.assistant-chatlist-row').first().click();
  await settle(page);
  await measure(page, 'DeskClean');
  await page.screenshot({ path: path.join(OUT, 'DeskClean.Assistant.png') });
  await geometry(page, electronApp, 'DeskClean', 'DeskClean');
  await pairShot(electronApp, 'DeskClean', 'DeskClean.Assistant', 1020, 'DeskClean');
  await compareWithBoard(electronApp, 'DeskClean');
});

/** Right-dock crop of board and screenshot side by side, plus the pixel difference, for the report. */
async function pairShot(app: ElectronApplication, board: string, shot: string, left: number, name: string): Promise<void> {
  const boards = path.resolve(__dirname, '..', 'docs', 'design', 'work-panel', 'boards');
  const boardUrl = pathToFileURL(path.join(boards, `${board}.png`)).href;
  const shotUrl = pathToFileURL(path.join(OUT, `${shot}.png`)).href;
  const width = WIDTH - left;
  const crop = (src: string, extra = ''): string =>
    `<div style="position:relative;width:${width}px;height:${HEIGHT}px;overflow:hidden;background:#000"><img src="${src}" style="position:absolute;left:-${left}px;top:0;${extra}"></div>`;
  const html = `<!doctype html><body style="margin:0;background:#444;display:flex;gap:8px">${crop(boardUrl)}${crop(shotUrl)}<div style="position:relative;width:${width}px;height:${HEIGHT}px;overflow:hidden;background:#000">${[boardUrl, shotUrl].map((src, i) => `<img src="${src}" style="position:absolute;left:-${left}px;top:0;${i === 1 ? 'mix-blend-mode:difference' : ''}">`).join('')}</div></body>`;
  const file = path.join(OUT, `${name}.pair.html`);
  fs.writeFileSync(file, html);
  const opened = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = new BrowserWindow({ width: 1200, height: 910, show: false });
    void win.loadURL(target);
  }, pathToFileURL(file).href);
  const win = await opened;
  await win.waitForLoadState('load');
  await win.waitForTimeout(600);
  await win.screenshot({ path: path.join(OUT, `${name}.pair.png`), clip: { x: 0, y: 0, width: width * 3 + 16, height: HEIGHT } });
  await win.close();
}

/**
 * The geometry the report compares: every text-bearing element or control inside the
 * Assistant, relative to the Talk-to group (the frame above it is the base's), as JSON.
 */
const DUMP = `(rootSel, anchorSel) => {
  const root = document.querySelector(rootSel);
  const anchor = root.querySelector(anchorSel).getBoundingClientRect();
  const out = [];
  for (const node of root.querySelectorAll('*')) {
    const own = [...node.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    const control = ['BUTTON', 'TEXTAREA'].includes(node.tagName) || node.classList.contains('cm-content');
    const boxed = typeof node.className === 'string' && /(^| )(card|card-body|card-label|card-attachments|decision-[a-z]+|assistant-thread)( |$)/.test(node.className);
    if (own === '' && !control && !boxed) { continue; }
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { continue; }
    const label = boxed ? '#' + node.className : own !== '' ? own : (node.getAttribute('aria-label') || node.getAttribute('title') || node.tagName).trim();
    out.push([Math.round(r.left - anchor.left), Math.round(r.top - anchor.top), Math.round(r.width), Math.round(r.height), label.slice(0, 32)].join(' | '));
  }
  return out.sort((a, b) => Number(a.split(' | ')[1]) - Number(b.split(' | ')[1]) || Number(a.split(' | ')[0]) - Number(b.split(' | ')[0]));
}`;

async function dumpBoard(app: ElectronApplication, board: string): Promise<string[]> {
  const file = path.resolve(__dirname, '..', 'docs', 'design', 'work-panel', 'boards', `${board}.dc.html`);
  const opened = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true });
    void win.loadURL(target);
  }, pathToFileURL(file).href);
  const win = await opened;
  await win.waitForLoadState('load');
  await win.waitForSelector('[aria-label="Talk to"]', { timeout: 15000 });
  const rows = (await win.evaluate(`(${DUMP})('aside[aria-label="Right dock"], aside[aria-label="Assistant"]', '[aria-label="Talk to"]')`)) as string[];
  await win.close();
  return rows;
}

async function dumpApp(page: Page): Promise<string[]> {
  return (await page.evaluate(`(${DUMP})('app-panel-frame:has(.assistant-panel)', '.assistant-targets')`)) as string[];
}

async function geometry(page: Page, app: ElectronApplication, board: string, name: string): Promise<void> {
  fs.writeFileSync(path.join(OUT, `${name}.board.txt`), (await dumpBoard(app, board)).join('\n'));
  fs.writeFileSync(path.join(OUT, `${name}.app.txt`), (await dumpApp(page)).join('\n'));
}

/** Checklist step 9: boards/compare.html over board and screenshot, one capture per mode. */
async function compareWithBoard(app: ElectronApplication, board: string): Promise<void> {
  const boards = path.resolve(__dirname, '..', 'docs', 'design', 'work-panel', 'boards');
  const url = pathToFileURL(path.join(boards, 'compare.html'));
  url.searchParams.set('board', pathToFileURL(path.join(boards, `${board}.png`)).href);
  url.searchParams.set('shot', pathToFileURL(path.join(OUT, `${board}.Assistant.png`)).href);
  const opened = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = new BrowserWindow({ width: 1500, height: 1000, show: false });
    void win.loadURL(target);
  }, url.href);
  const compare = await opened;
  await compare.waitForLoadState('load');
  await compare.waitForTimeout(500);
  for (const mode of ['side', 'overlay', 'swipe', 'diff']) {
    await compare.locator(`[data-mode="${mode}"]`).click();
    await compare.waitForTimeout(300);
    await compare.locator('#stage').screenshot({ path: path.join(OUT, `${board}.Assistant.${mode}.png`) });
  }
  await compare.close();
}
