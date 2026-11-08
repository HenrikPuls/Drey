import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, type ElectronApplication, type Page } from './fixtures/drey';

/**
 * NOT a regression suite: this puts the built app in the state board 9a
 * (`docs/design/work-panel/boards/DeskClean.png`) shows and takes the
 * screenshot the fidelity checklist asks for. Opt-in, so CI skips it:
 *
 *   . .\env.ps1
 *   $env:DREY_FIDELITY_SHOTS = '1'
 *   npm run e2e:run -- fidelity-deskclean
 *
 * Output: `test-results/fidelity/DeskClean.png` (1440x900, scale factor 1),
 * to load into `docs/design/work-panel/boards/compare.html`. The vault is
 * English (CLAUDE.md, screenshots shown to the owner), so the sample text
 * differs from the board's; the layout may not.
 */

const RUN = !!process.env['DREY_FIDELITY_SHOTS'];
test.skip(!RUN, 'set DREY_FIDELITY_SHOTS=1 -- the board 9a screenshot');

const OUT = path.resolve(__dirname, '..', 'test-results', 'fidelity');
const WIDTH = 1440;
const HEIGHT = 900;

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: review, title: Review, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

const T0017 = [
  '---',
  'id: T-0017',
  'title: "A8 large modules"',
  'repo: drey',
  'priority: normal',
  'branch: t/T-0017',
  "entered-inbox: '2026-10-20T09:00:00Z'",
  "entered-prioritized: '2026-10-30T09:00:00Z'",
  '---',
  '',
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
  '',
].join('\n');

const OTHER = ['---', 'id: T-0091', 'title: "Palette order"', 'repo: drey', 'priority: normal', "entered-prioritized: '2026-10-30T09:00:00Z'", '---', '', '## Description', '', 'Later.', ''].join('\n');

const CHAT = [
  '---',
  'kind: chat',
  'provider: openai-compat',
  'model: glm-5.3-flash',
  'note: v-main::tickets/20-prioritized/T-0017.md',
  '---',
  '',
  '## User',
  '',
  '"... just as real and fixed as the Big Bang; it is simply positioned elsewhere." What does that mean?',
  '',
  '## Assistant',
  '',
  'The paragraph spells out the central idea of the story: the difference between beginning and end is not a property of time itself but of our point of view.',
  '',
  '**The human perspective:** We experience ourselves in the middle of a river. The beginning lies behind us, known and unchangeable. The end lies ahead, unknown.',
  '',
  '**The block-universe perspective:** Seen as a static landscape, time loses the contrast. Beginning and end are two places in the same space.',
  '',
].join('\n');

const seed: Record<string, string> = {
  'tickets/_meta/pipeline.md': PIPELINE,
  'tickets/_meta/repos.md': REPOS,
  'tickets/10-inbox/T-0101.md': OTHER.replace(/T-0091/g, 'T-0101'),
  'tickets/20-prioritized/T-0017.md': T0017,
  'tickets/20-prioritized/T-0091.md': OTHER,
  'diagram-2026-11-04.md': '# Diagram\n\nA note.\n',
  'the time - a short story.md': '# The time\n\nA story.\n',
  'chats/2026/11/2026-11-06-beginning-and-end.md': CHAT,
};

/**
 * Board 9a's arrangement of the Work view: the docks, what is open, what is
 * folded, the widths. The ids come from the strips, by the panel's name.
 */
async function arrangeDocks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ids = new Map<string, string>();
    for (const btn of document.querySelectorAll<HTMLElement>('app-dock-strip button[data-widget]')) {
      ids.set((btn.getAttribute('title') ?? '').split(' · ')[0], btn.dataset['widget'] ?? '');
    }
    const named = (names: string[]): string[] => names.map((n) => ids.get(n)).filter((id): id is string => id !== undefined);
    const left = named(['Calendar', 'Files', 'Backlinks', 'Source control', 'Outline', 'Tickets']);
    const right = named(['Find', 'Work', 'Assistant']);
    const shown = new Set(named(['Calendar', 'Files', 'Outline', 'Find', 'Assistant']));
    const saved = JSON.parse(localStorage.getItem('drey.dock') ?? '{}') as { active: string; views: Record<string, Record<string, unknown>> };
    const view = saved.views[saved.active];
    const all = [...ids.values()];
    const rest = all.filter((id) => !left.includes(id) && !right.includes(id));
    saved.views[saved.active] = {
      ...view,
      dock: { left: left.concat(rest), right, bottom: [] },
      open: Object.fromEntries(all.map((id) => [id, shown.has(id)])),
      flexes: Object.fromEntries(all.map((id) => [id, 1])),
      collapsed: Object.fromEntries(named(['Find']).map((id) => [id, true])),
      leftW: 300,
      rightW: 420,
      foldedSides: [],
    };
    saved.views[saved.active]['flexes'] = { ...(saved.views[saved.active]['flexes'] as object), [ids.get('Files') ?? '']: 430, [ids.get('Outline') ?? '']: 140 };
    localStorage.setItem('drey.dock', JSON.stringify(saved));
  });
}

/** Opens a file of the seeded vault in a tab of its own. */
async function openInNewTab(page: Page, name: string): Promise<void> {
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).first().click({ button: 'right' });
  await page.locator('app-dock[side="left"] .ctx-menu button', { hasText: 'Open in new tab' }).click();
}

/** The fleet runner does not run here: the status bar's Autopilot item comes from a pushed snapshot. */
async function pushFleet(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }, data) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('plugin:event', data);
    }
  }, {
    pluginId: 'tickets',
    event: 'fleet-changed',
    data: {
      runs: [],
      chain: { configured: true, master: 'run', columns: {}, inFlight: [], queue: [] },
    },
  });
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

/** Checklist step 9: boards/compare.html over board and screenshot, one capture per mode. */
async function compareWithBoard(app: ElectronApplication): Promise<void> {
  const boards = path.resolve(__dirname, '..', 'docs', 'design', 'work-panel', 'boards');
  const url = pathToFileURL(path.join(boards, 'compare.html'));
  url.searchParams.set('board', pathToFileURL(path.join(boards, 'DeskClean.png')).href);
  url.searchParams.set('shot', pathToFileURL(path.join(OUT, 'DeskClean.png')).href);
  const opened = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = new BrowserWindow({ width: 1500, height: 1000, show: false });
    void win.loadURL(target);
  }, url.href);
  const compare = await opened;
  await compare.waitForLoadState('load');
  await compare.waitForTimeout(500);
  for (const mode of ['overlay', 'swipe', 'diff']) {
    await compare.locator(`[data-mode="${mode}"]`).click();
    await compare.waitForTimeout(300);
    await compare.locator('#stage').screenshot({ path: path.join(OUT, `DeskClean.${mode}.png`) });
  }
}

test.use({
  seedVault: seed,
  launchArgs: ['--force-device-scale-factor=1'],
  appConfig: {
    plugins: { disabled: ['sample', 'templates', 'browser', 'drawio', 'ocr', 'meeting'] },
    spellcheck: { enabled: false },
    widgets: { disabled: ['windows', 'tickets-capacity'] },
    llm: { enabled: true, provider: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: null, model: 'glm-5.3-flash' },
  },
});

test('board 9a: the frame in the Work view with T-0017 open', async ({ page, electronApp }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+2');
  await page.waitForTimeout(400);
  await arrangeDocks(page);
  await page.reload();
  await sizeWindow(electronApp);
  await expect(page.locator('app-titlebar [role="tablist"] [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const files = page.locator('app-dock[side="left"]');
  await files.locator('.node.folder', { hasText: 'tickets' }).first().click();
  await files.locator('.node.folder', { hasText: '20-prioritized' }).first().click();
  await openInNewTab(page, 'diagram-2026-11-04.md');
  await openInNewTab(page, 'the time - a short story.md');
  await openInNewTab(page, 'T-0091.md');
  await openInNewTab(page, 'T-0017.md');
  // "Open in new tab" pins; the board's tabs are not pinned. So is the
  // formatting strip: the board shows the meta bar without it.
  const tabs = page.locator('app-tab-bar .tab');
  for (let i = 0; i < (await tabs.count()); i++) {
    if ((await tabs.nth(i).locator('.pin').count()) > 0) {
      await tabs.nth(i).click({ button: 'right' });
      await page.locator('app-tab-bar .ctx-menu button', { hasText: 'Unpin tab' }).click();
    }
  }
  await page.locator('app-editor .chrome app-markdown-toolbar button[aria-label="Unpin formatting toolbar"]').first().click();
  await pushFleet(electronApp);
  // The board's view is its saved layout: no "changed" dot.
  await page.locator('app-view-switcher .vs-layout').click();
  const saveLayout = page.locator('app-view-switcher .ctx-menu button', { hasText: 'Save layout' });
  if (await saveLayout.isEnabled()) {
    await saveLayout.click();
  } else {
    await page.keyboard.press('Escape');
    await page.locator('app-view-switcher .ctx-backdrop').click({ force: true });
  }
  await page.mouse.move(700, 500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(1500);

  // The measures the board names, for the report (console, no assertion).
  const measured = await page.evaluate(() => {
    const box = (sel: string): string => {
      const el = document.querySelector(sel);
      if (el === null) {
        return 'absent';
      }
      const r = el.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    return {
      window: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
      theme: document.documentElement.dataset['theme'] ?? '',
      titlebar: box('app-titlebar'),
      strip: box('app-dock-strip'),
      head: box('app-panel-frame:not(.closed) .head'),
      tabbar: box('app-tab-bar'),
      meta: box('app-editor .chrome'),
      status: box('app-status-bar'),
    };
  });
  console.log(JSON.stringify(measured));
  await page.screenshot({ path: path.join(OUT, 'DeskClean.png') });
  // The board forces the Files header's hover controls on; shown here for real.
  await page.locator('app-panel-frame', { has: page.locator('app-files-panel') }).locator('.head').hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'DeskClean.files-hover.png') });
  await compareWithBoard(electronApp);
});
