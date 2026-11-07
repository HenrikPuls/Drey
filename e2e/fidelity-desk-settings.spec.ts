import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from './fixtures/drey';

/**
 * NOT a regression suite: puts the built app in the states of board 7g
 * (DeskSettings) and the desktop part of board 10t (Autopilot) and takes the
 * screenshots the fidelity checklist asks for. Opt-in, so CI skips it:
 *
 *   . .\env.ps1
 *   $env:DREY_FIDELITY_SHOTS = '1'
 *   npm run e2e:run -- fidelity-desk-settings
 *
 * Output: `test-results/fidelity/<Board>.png` (1440x900, scale factor 1).
 */

const RUN = !!process.env['DREY_FIDELITY_SHOTS'];
test.skip(!RUN, 'set DREY_FIDELITY_SHOTS=1 -- the screenshots of boards 7g and 10t');

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
  '  - { id: build, title: Building, handover: agent build-default, persona: ben }',
  '  - { id: ready, title: Ready to try, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

function persona(title: string, role: string, color: string, budget: number): string {
  return ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: qwen3-coder', '  pool: [qwen3-coder]', '  router: off', `color: '${color}'`, 'skills: []', `budget: ${budget}`, '---', `Who ${title} is.`, ''].join('\n');
}

function ticket(id: string, title: string, phase: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: "${title}"`,
    'repo: drey',
    'priority: normal',
    `branch: t/${id}`,
    "entered-inbox: '2026-10-20T09:00:00Z'",
    ...(phase === 'inbox' ? [] : [`entered-${phase}: '2026-10-30T09:00:00Z'`]),
    '---',
    '',
    '## Description',
    '',
    `${title} - what the owner wants.`,
    '',
    '## Log',
    '',
  ].join('\n');
}

const settled = (ticketId: string, personaId: string, cost: number): string =>
  JSON.stringify({ v: 1, ts: new Date().toISOString(), event: 'run_settled', ticket: ticketId, persona: personaId, model: 'qwen3-coder', tokensIn: 40_000, tokensOut: 3_000, cost });

const seed: Record<string, string> = {
  'tickets/_meta/pipeline.md': PIPELINE,
  'tickets/_meta/repos.md': REPOS,
  'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#f2d3e2', 3),
  'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#8ecbef', 15),
  'tickets/_meta/personas/ralf/persona.md': persona('Ralf', 'reviewer', '#bfe3cd', 4),
  'tickets/_meta/personas/tessa/persona.md': persona('Tessa', 'tester', '#f2cfae', 7),
  'tickets/_meta/ledger.jsonl': [settled('T-0121', 'ben', 4.1), ''].join('\n'),
  'tickets/10-inbox/T-0133.md': ticket('T-0133', 'Sync status in the title bar', 'inbox'),
  'tickets/40-build/T-0017.md': ticket('T-0017', 'A8 large modules', 'build'),
  'projects/Notes.md': '# Notes\n\n412 words of nothing in particular.\n',
};

async function pushChain(app: ElectronApplication, autopilot: { state: string; resumeAt?: string }): Promise<void> {
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
        runs: [],
        chain: {
          configured: true,
          master: autopilot.state === 'off' ? 'halted' : 'run',
          autopilot,
          columns: {},
          redStreak: {},
          cooldownUntil: {},
          poolSize: { opencode: 2, 'claude-code': 3 },
        },
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

test('boards 7g and 10t desktop: Settings, the Autopilot item', async ({ page, electronApp }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(OUT, { recursive: true });
  await sizeWindow(electronApp);
  await expect(page.locator('app-titlebar [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pushChain(electronApp, { state: 'on' });
  await page.waitForTimeout(800);

  // 10t desktop: the item and its popover in each state.
  const item = page.locator('app-status-bar button', { hasText: 'Autopilot' });
  await expect(item).toBeVisible({ timeout: 20_000 });
  await item.click();
  await expect(page.getByRole('dialog', { name: 'Autopilot' })).toBeVisible();
  await shoot(page, 'Autopilot.desktop-on');
  // The measures the board's markup gives (rects relative to the popover), for the comparison.
  const rects = await page.evaluate(() => {
    const dlg = document.querySelector('.tickets-autopilot-pop') as HTMLElement;
    const base = dlg.getBoundingClientRect();
    const rel = (e: Element): number[] => {
      const x = e.getBoundingClientRect();
      return [x.left - base.left, x.top - base.top, x.width, x.height].map((v) => Math.round(v * 10) / 10);
    };
    const o: Record<string, number[]> = { dialog: [base.left, base.top, base.width, base.height] };
    [...dlg.children].forEach((c, i) => (o[`child${i}`] = rel(c)));
    [...dlg.querySelectorAll('[role=radio]')].forEach((c, i) => (o[`seg${i}`] = rel(c)));
    const item = document.querySelector('app-status-bar button[aria-haspopup]') as HTMLElement;
    const ib = item.getBoundingClientRect();
    o['item'] = [ib.left, ib.top, ib.width, ib.height];
    const bb = item.parentElement!.getBoundingClientRect();
    o['bar'] = [bb.left, bb.top, bb.width, bb.height];
    return o;
  });
  fs.writeFileSync(path.join(OUT, 'Autopilot.desktop-rects.json'), JSON.stringify(rects));
  await pushChain(electronApp, { state: 'paused', resumeAt: new Date(new Date().setHours(18, 0, 0, 0)).toISOString() });
  await shoot(page, 'Autopilot.desktop-paused');
  await pushChain(electronApp, { state: 'off' });
  await shoot(page, 'Autopilot.desktop-off');
  await page.keyboard.press('Escape');
  await pushChain(electronApp, { state: 'on' });

  // 7g: Settings, the Tickets category, All devices.
  await page.locator('app-status-bar .settings').click();
  await expect(page.locator('app-settings .category').first()).toBeVisible();
  await page.locator('app-settings .category', { hasText: 'Tickets' }).first().click();
  await shoot(page, 'DeskSettings');
  // The rest of the page, as far as the board's sample content goes (the board shows it only below its fold).
  await page.locator('app-settings .section-entry', { hasText: 'Budget and runners' }).click();
  await page.waitForTimeout(700);
  await shoot(page, 'DeskSettings.budget');
  await page.locator('app-settings .section-entry', { hasText: 'Walkthrough videos' }).click();
  await page.waitForTimeout(700);
  await shoot(page, 'DeskSettings.videos');
  await page.locator('app-settings .section-entry', { hasText: 'Devices' }).click();
  await page.waitForTimeout(700);
  await shoot(page, 'DeskSettings.devices');
  // Optional: a probe script (returns element rects) to compare against the board's markup.
  const probe = process.env['FIDELITY_PROBE'];
  if (probe) {
    const rects = await page.evaluate(fs.readFileSync(probe, 'utf8'));
    fs.writeFileSync(path.join(OUT, 'DeskSettings.rects.json'), JSON.stringify(rects));
  }
});
