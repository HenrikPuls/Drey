import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Locator, Page } from './drey';

/**
 * Shared pieces of the desk fidelity shots of boards 9d and 9e (req-162):
 * the 9a Work view with T-0017 open (the same seed as
 * `fidelity-deskclean.spec.ts`), the dock arrangement by panel name, the
 * window size and the compare.html capture. Not a regression helper.
 */

export const OUT = path.resolve(__dirname, '..', '..', 'test-results', 'fidelity');
export const WIDTH = 1440;
export const HEIGHT = 900;

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

/** The 9a desk: tickets, two notes and the chat the Assistant shows. */
export const DESK_SEED: Record<string, string> = {
  'tickets/_meta/pipeline.md': PIPELINE,
  'tickets/_meta/repos.md': REPOS,
  // In the inbox with its inbox date: a ticket whose dates disagree with its
  // folder gets a normalization commit as soon as the vault is a repository.
  'tickets/10-inbox/T-0101.md': OTHER.replace(/T-0091/g, 'T-0101').replace('entered-prioritized', 'entered-inbox'),
  'tickets/20-prioritized/T-0017.md': T0017,
  'tickets/20-prioritized/T-0091.md': OTHER,
  'diagram-2026-11-04.md': '# Diagram\n\nA note.\n',
  'the time - a short story.md': '# The time\n\nA story.\n',
  'chats/2026/11/2026-11-06-beginning-and-end.md': CHAT,
};

/** The app config every desk shot uses (as fidelity-deskclean). */
export const DESK_CONFIG: Record<string, unknown> = {
  plugins: { disabled: ['sample', 'templates', 'browser', 'drawio', 'ocr', 'meeting'] },
  spellcheck: { enabled: false },
  widgets: { disabled: ['windows', 'tickets-capacity'] },
  llm: { enabled: true, provider: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: null, model: 'glm-5.3-flash' },
};

export interface DockArrangement {
  /** Left dock panels in order, by their strip title. */
  readonly left: readonly string[];
  /** Panels open (shown in their dock). */
  readonly shown: readonly string[];
  /** Panels folded to their header. */
  readonly collapsed: readonly string[];
  /** Flex weights by panel name (others 1). */
  readonly flexes: Readonly<Record<string, number>>;
}

/** Writes the arrangement into the stored layout; the caller reloads. */
export async function arrangeDocks(page: Page, arrangement: DockArrangement): Promise<void> {
  await page.evaluate((a) => {
    const ids = new Map<string, string>();
    for (const btn of document.querySelectorAll<HTMLElement>('app-dock-strip button[data-widget]')) {
      ids.set((btn.getAttribute('title') ?? '').split(' · ')[0], btn.dataset['widget'] ?? '');
    }
    const named = (names: readonly string[]): string[] =>
      names.map((n) => ids.get(n)).filter((id): id is string => id !== undefined);
    const left = named(a.left);
    const right = named(['Work', 'Assistant']);
    const shown = new Set(named([...a.shown, 'Assistant']));
    const saved = JSON.parse(localStorage.getItem('drey.dock') ?? '{}') as {
      active: string;
      views: Record<string, Record<string, unknown>>;
    };
    const view = saved.views[saved.active];
    const all = [...ids.values()];
    const rest = all.filter((id) => !left.includes(id) && !right.includes(id));
    const flexes: Record<string, number> = Object.fromEntries(all.map((id) => [id, 1]));
    for (const [name, flex] of Object.entries(a.flexes)) {
      const id = ids.get(name);
      if (id !== undefined) {
        flexes[id] = flex;
      }
    }
    saved.views[saved.active] = {
      ...view,
      dock: { left: left.concat(rest), right, bottom: [] },
      open: Object.fromEntries(all.map((id) => [id, shown.has(id)])),
      flexes,
      collapsed: Object.fromEntries(named(a.collapsed).map((id) => [id, true])),
      leftW: 300,
      rightW: 420,
      foldedSides: [],
    };
    localStorage.setItem('drey.dock', JSON.stringify(saved));
  }, arrangement);
}

export async function sizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.getURL().startsWith('app://')) {
          win.setContentSize(size.width, size.height);
        }
      }
    },
    { width: WIDTH, height: HEIGHT },
  );
}

/** A plugin event as main would push it (the fleet snapshot, a git status round). */
export async function pushPluginEvent(app: ElectronApplication, pluginId: string, event: string, data: unknown): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('plugin:event', payload);
      }
    },
    { pluginId, event, data },
  );
}

/** The fleet runner does not run here: the status bar's Autopilot item comes from a pushed snapshot. */
export async function pushFleet(app: ElectronApplication): Promise<void> {
  await pushPluginEvent(app, 'tickets', 'fleet-changed', {
    runs: [],
    chain: { configured: true, master: 'run', columns: {}, inFlight: [], queue: [] },
  });
}

/** Opens a file of the seeded vault in a tab of its own. */
export async function openInNewTab(page: Page, name: string): Promise<void> {
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).first().click({ button: 'right' });
  await page.locator('app-dock[side="left"] .ctx-menu button', { hasText: 'Open in new tab' }).click();
}

/**
 * The 9a editor: the four tabs of the board with T-0017 active, none
 * pinned, the formatting strip not pinned. The Files panel must be open
 * (unfolded) while this runs.
 */
export async function openDeskTabs(page: Page): Promise<void> {
  const files = page.locator('app-dock[side="left"]');
  await files.locator('.node.folder', { hasText: 'tickets' }).first().click();
  await files.locator('.node.folder', { hasText: '20-prioritized' }).first().click();
  await openInNewTab(page, 'diagram-2026-11-04.md');
  await openInNewTab(page, 'the time - a short story.md');
  await openInNewTab(page, 'T-0091.md');
  await openInNewTab(page, 'T-0017.md');
  const tabs = page.locator('app-tab-bar .tab');
  for (let i = 0; i < (await tabs.count()); i++) {
    if ((await tabs.nth(i).locator('.pin').count()) > 0) {
      await tabs.nth(i).click({ button: 'right' });
      await page.locator('app-tab-bar .ctx-menu button', { hasText: 'Unpin tab' }).click();
    }
  }
  const unpin = page.locator('app-editor .chrome app-markdown-toolbar button[aria-label="Unpin formatting toolbar"]').first();
  if ((await unpin.count()) > 0) {
    await unpin.click();
  }
}

/** The board's view is its saved layout: no "changed" dot on the view switcher. */
export async function saveLayout(page: Page): Promise<void> {
  await page.locator('app-view-switcher .vs-layout').click();
  const save = page.locator('app-view-switcher .ctx-menu button', { hasText: 'Save layout' });
  if (await save.isEnabled()) {
    await save.click();
  } else {
    await page.keyboard.press('Escape');
    await page.locator('app-view-switcher .ctx-backdrop').click({ force: true });
  }
}

/** A panel frame by a class its body carries. */
export function panelFrame(page: Page, bodyClass: string): Locator {
  return page.locator('app-panel-frame', { has: page.locator(`.${bodyClass}`) });
}

/** A crop of the window: the left dock column, from the panel's top for `height` px. */
export async function shootPanel(page: Page, frame: Locator, file: string, extraWidth = 0): Promise<void> {
  const box = await frame.boundingBox();
  if (box === null) {
    throw new Error(`${file}: the panel is not visible`);
  }
  await page.screenshot({
    path: path.join(OUT, file),
    clip: { x: box.x, y: box.y, width: box.width + extraWidth, height: Math.min(box.height, HEIGHT - box.y) },
  });
}

/** Checklist step 9: boards/compare.html over board and screenshot, one capture per mode. */
export async function compareWithBoard(app: ElectronApplication, board: string): Promise<void> {
  const boards = path.resolve(__dirname, '..', '..', 'docs', 'design', 'work-panel', 'boards');
  const url = pathToFileURL(path.join(boards, 'compare.html'));
  url.searchParams.set('board', pathToFileURL(path.join(boards, `${board}.png`)).href);
  url.searchParams.set('shot', pathToFileURL(path.join(OUT, `${board}.png`)).href);
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
    await compare.locator('#stage').screenshot({ path: path.join(OUT, `${board}.${mode}.png`) });
  }
}

export function ensureOut(): void {
  fs.mkdirSync(OUT, { recursive: true });
}
