import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, type Locator, type Page, type ElectronApplication } from './fixtures/drey';

/**
 * NOT a regression suite: puts the built app in the states boards 9c
 * (`DeskFind`, 1440x900, Search mode) and `DeskFindParts` (the crops) show and
 * takes the screenshots the fidelity checklist asks for. Opt-in, so CI skips it:
 *
 *   . .\env.ps1
 *   $env:DREY_FIDELITY_SHOTS = '1'
 *   npm run e2e:run -- fidelity-desk-find
 *
 * Output: `test-results/fidelity/DeskFind.png` (the window) and
 * `DeskFindParts-<n>-<state>.png` (the panel, scale factor 1). The vault is
 * English; the sample text differs from the board's, the layout may not.
 */

const RUN = !!process.env['DREY_FIDELITY_SHOTS'];
test.skip(!RUN, 'set DREY_FIDELITY_SHOTS=1 -- the board 9c screenshots');

const OUT = path.resolve(__dirname, '..', 'test-results', 'fidelity');

const iso = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
};

const RELAUNCH = [
  '# Website relaunch',
  '',
  '## Brand #project',
  '',
  'The new logo keeps the blue of the old one.',
  '',
  '## Next steps #project',
  '',
  'Review the logo drafts before Friday.',
  `- [ ] Send the offer to Miller & Co 📅 ${iso(-4)} ⏫`,
  `- [ ] Review the logo drafts 📅 ${iso(0)}`,
  `- [ ] Book the photographer 📅 ${iso(4)} ⏫`,
  '',
  '## Shoot #project',
  '',
  'Print the logo on the backdrop.',
  '',
].join('\n');

const REVIEW = [
  '# Design review',
  '',
  '## Decisions #project',
  '',
  'Dana prefers the round logo.',
  '',
  '## Action items #project',
  '',
  'Ask Dana about the logo colours.',
  '- [ ] Share the slides with the team',
  `- [ ] Ask Dana about the colour tokens 🔽`,
  '',
].join('\n');

const BRAND = ['# Brand guide', '', '## Logo #project', '', 'Use the logo on a light background only.', '- [x] Renew the domain', 'Draft the newsletter intro #task', ''].join('\n');

test.use({
  seedVault: {
    'projects/website-relaunch.md': RELAUNCH,
    'meetings/2026-11-05 design review.md': REVIEW,
    'projects/brand-guide.md': BRAND,
  },
  launchArgs: ['--force-device-scale-factor=1'],
  appConfig: {
    plugins: { disabled: ['sample', 'templates', 'browser', 'drawio', 'ocr', 'meeting'] },
    spellcheck: { enabled: false },
  },
});

async function sizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.getURL().startsWith('app://')) {
        win.setContentSize(1440, 900);
      }
    }
  });
}

/** Board 9c's left dock: Calendar and Files folded or open as drawn, Find taking the rest. */
async function arrangeDocks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ids = new Map<string, string>();
    for (const btn of document.querySelectorAll<HTMLElement>('app-dock-strip button[data-widget]')) {
      ids.set((btn.getAttribute('title') ?? '').split(' · ')[0] ?? '', btn.dataset['widget'] ?? '');
    }
    const named = (names: string[]): string[] => names.map((n) => ids.get(n)).filter((id): id is string => id !== undefined);
    const shown = new Set(named(['Calendar', 'Files', 'Find', 'Assistant']));
    const saved = JSON.parse(localStorage.getItem('drey.dock') ?? '{}') as { active: string; views: Record<string, Record<string, unknown>> };
    const view = saved.views[saved.active] ?? {};
    const all = [...ids.values()];
    const right = named(['Assistant']);
    const left = all.filter((id) => !right.includes(id));
    saved.views[saved.active] = {
      ...view,
      dock: { left, right, bottom: [] },
      open: Object.fromEntries(all.map((id) => [id, shown.has(id)])),
      flexes: Object.fromEntries(all.map((id) => [id, 1])),
      collapsed: Object.fromEntries(named(['Files']).map((id) => [id, true])),
      leftW: 300,
      rightW: 420,
      foldedSides: [],
    };
    localStorage.setItem('drey.dock', JSON.stringify(saved));
  });
}

const panelOf = (page: Page): Locator => page.locator('app-panel-frame', { has: page.locator('.find') });

async function shoot(panel: Locator, name: string): Promise<void> {
  await panel.page().mouse.move(900, 600);
  await panel.screenshot({ path: path.join(OUT, `DeskFindParts-${name}.png`) });
}

test('boards 9c DeskFind and DeskFindParts: the Find panel', async ({ page, electronApp }) => {
  fs.mkdirSync(OUT, { recursive: true });
  await expect(page.locator('app-dock-strip button[aria-label="Show Find"]')).toBeVisible({ timeout: 30_000 });
  await arrangeDocks(page);
  await page.reload();
  await sizeWindow(electronApp);
  await expect(page.locator('app-dock-strip button[aria-label="Hide Find"]')).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const panel = panelOf(page);
  const field = panel.locator('.find-field .tag-field-input').first();
  // Wait for the index sweep, then the Search mode of the board: #project + logo.
  await expect(async () => {
    await field.fill('#project logo');
    await field.press('Enter');
    await expect(panel.locator('.find-hit').first()).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 30_000 });
  await page.mouse.move(900, 600);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: path.join(OUT, 'DeskFind.png') });
  // Board 10 marks the opened hit: open the first one, then crop its group.
  await panel.locator('.find-hit').first().click();
  await page.mouse.move(900, 600);
  await shoot(panel, '10-hit-group');
  const groupTop = await panel.evaluate((root) => {
    const group = root.querySelector('.find-group');
    return group === null ? 0 : Math.round(group.getBoundingClientRect().top - root.getBoundingClientRect().top);
  });
  // The measures the board names, for the report (console, no assertion).
  const measured = await page.evaluate(() => {
    const box = (sel: string): string => {
      const el = document.querySelector(sel);
      if (el === null) {
        return 'absent';
      }
      const b = el.getBoundingClientRect();
      return `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`;
    };
    return ['.find-tabs', '.find-field', '.find-group-head', '.find-hit-wrap', '.find-chevron'].map(
      (sel) => `${sel} ${box(sel)}`,
    );
  });
  console.log(measured.join('\n'));

  // 4 · field at rest, 5 · Replace on, 6 · tag completion
  await panel.locator('.find-field').first().locator('button[aria-label="Replace"]').click();
  await shoot(panel, '5-replace-on');
  await panel.locator('.find-field').first().locator('button[aria-label="Replace"]').click();
  await panel.locator('.find-field button[aria-label="Clear"]').click();
  await field.pressSequentially('#pro');
  await shoot(panel, '6-completion');
  await field.press('Escape');

  await field.fill('logo');
  await field.press('Enter');
  await expect(panel.locator('.find-hit').first()).toBeVisible();
  await panel.locator('.find-hit').first().focus();
  await panel.locator('button[aria-label="More"]').click();
  await shoot(panel, '8-menu-search');
  await page.keyboard.press('Escape');

  // 7 · empty and error
  await field.fill('zzzz-nothing');
  await field.press('Enter');
  await shoot(panel, '7-empty');
  await panel.locator('button[aria-label="More"]').click();
  await page.locator('.find-menu-item', { hasText: 'Regular expression' }).click();
  await field.fill('logo(');
  await field.press('Enter');
  await shoot(panel, '7-error');
  await panel.locator('button[aria-label="More"]').click();
  await page.locator('.find-menu-item', { hasText: 'Regular expression' }).click();

  // 1 · Tasks mode, 9 · its menu, 12 · rows, 13 · due-date order
  await panel.locator('.find-field button[aria-label="Clear"]').click();
  await page.locator('.find-tab', { hasText: 'Tasks' }).click();
  await expect(panel.locator('.find-task').first()).toBeVisible({ timeout: 15_000 });
  await shoot(panel, '1-tasks');
  await panel.locator('button[aria-label="More"]').click();
  await shoot(panel, '9-menu-tasks');
  await page.locator('.find-menu-item', { hasText: 'Due date' }).click();
  await shoot(panel, '13-due-order');

  // 2 · folded
  await page.locator('app-panel-frame', { has: page.locator('.find') }).locator('button.chevron').click();
  await shoot(panel, '2-folded');

  await compareWithBoards(electronApp, groupTop);
});

/**
 * Checklist step 9: boards/compare.html over board and screenshot, per
 * region. The window is the whole of `DeskFind`; the two crops cut the
 * board's collage (`DeskFindParts`) and the panel shot to the same size.
 */
async function compareWithBoards(app: ElectronApplication, groupTop: number): Promise<void> {
  const boards = path.resolve(__dirname, '..', 'docs', 'design', 'work-panel', 'boards');
  const compareUrl = pathToFileURL(path.join(boards, 'compare.html'));
  const opened = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = new BrowserWindow({ width: 1500, height: 1000, show: false });
    void win.loadURL(target);
  }, compareUrl.href);
  const win = await opened;
  await win.waitForLoadState('load');

  /** Cuts `rect` out of the PNG at `file` into `out`. */
  const crop = async (file: string, rect: [number, number, number, number], out: string): Promise<string> => {
    const url = await win.evaluate(
      async ({ src, r }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = r[2];
        canvas.height = r[3];
        canvas.getContext('2d')!.drawImage(img, r[0], r[1], r[2], r[3], 0, 0, r[2], r[3]);
        return canvas.toDataURL('image/png');
      },
      { src: pathToFileURL(file).href, r: rect },
    );
    fs.writeFileSync(out, Buffer.from(url.split(',')[1] ?? '', 'base64'));
    return out;
  };

  const pass = async (name: string, boardPng: string, shotPng: string): Promise<void> => {
    const target = new URL(compareUrl.href);
    target.searchParams.set('board', pathToFileURL(boardPng).href);
    target.searchParams.set('shot', pathToFileURL(shotPng).href);
    await win.goto(target.href);
    await win.waitForLoadState('load');
    await win.waitForTimeout(500);
    for (const mode of ['side', 'overlay', 'swipe', 'diff']) {
      await win.locator(`[data-mode="${mode}"]`).click();
      await win.waitForTimeout(250);
      await win.locator('#stage').screenshot({ path: path.join(OUT, `${name}.${mode}.png`) });
    }
    console.log(`${name}: ${await win.locator('#info').innerText()}`);
  };

  await pass('DeskFind', path.join(boards, 'DeskFind.png'), path.join(OUT, 'DeskFind.png'));

  const parts = path.join(boards, 'DeskFindParts.png');
  // Board 10: the group head and its two hits (300 px box, 1 px border).
  await pass(
    'DeskFindParts-10-hit-group',
    await crop(parts, [1136, 79, 298, 132], path.join(OUT, 'DeskFindParts-10.board.png')),
    await crop(path.join(OUT, 'DeskFindParts-10-hit-group.png'), [0, groupTop, 298, 132], path.join(OUT, 'DeskFindParts-10.shot.png')),
  );
  // Board 1: the Tasks mode with the panel header, 518 px of it.
  await pass(
    'DeskFindParts-1-tasks',
    await crop(parts, [50, 75, 298, 518], path.join(OUT, 'DeskFindParts-1.board.png')),
    await crop(path.join(OUT, 'DeskFindParts-1-tasks.png'), [0, 0, 298, 518], path.join(OUT, 'DeskFindParts-1.shot.png')),
  );
}
