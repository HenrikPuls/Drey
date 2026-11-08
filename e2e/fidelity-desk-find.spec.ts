import * as fs from 'node:fs';
import * as path from 'node:path';
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
  await shoot(panel, '10-hit-group');
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
});
