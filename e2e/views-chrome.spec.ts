import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

// The Work view starts a tickets engine; a home of its own keeps this test
// off the owner's live engine and board (see work-view.spec.ts).
const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

function stopEngine(): void {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(engineHome, '.drey-engine', 'service.lock'), 'utf8')) as { pid?: number };
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

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Ideas, handover: manual }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'notes/plain.md': '# A plain note\n\nNothing to do with tickets.\n',
    'notes/second.md': '# Second note\n\nAnother one.\n',
  },
});

/**
 * Views chrome (E12-18, boards 7h/7i): one segmented control with a dot on
 * the changed view, ONE Layout menu, the tab menu's inline "Show this tab in"
 * list and "Go to the Work view", Open windows "N here · M elsewhere" and a dock strip
 * that keeps ten icons on one line.
 */
test.describe('Views chrome (E12-18)', () => {
  test('Layout menu, tab menu and Open windows follow the boards', async ({ page }, testInfo) => {
    const tabs = page.locator('[role="tablist"][aria-label="Views"] [role="tab"]');
    await expect(tabs).toHaveText(['Notes', 'Work', 'Crew']);

    // A note open in Notes, shown in Work too.
    const files = page.locator('app-files-panel');
    await files.getByText('notes', { exact: true }).click();
    await files.getByText('plain.md', { exact: true }).click();
    await page.locator('app-tab-bar .tab').first().click({ button: 'right' });
    await page.locator('app-tab-bar .ctx-menu .ctx-view').getByText('Work', { exact: true }).click();

    // A layout change puts the dot on Notes only; there are no loose icons.
    await page.locator('app-dock-strip button[data-widget="outline"]').first().click();
    await expect(tabs.nth(0).locator('.vs-dot')).toBeVisible();
    // Grey: orange means needs you only (fidelity ruling O5).
    await expect(tabs.nth(0).locator('.vs-dot')).toHaveClass(/vs-dot-layout/);
    await expect(tabs.nth(1).locator('.vs-dot')).toHaveCount(0);
    await expect(page.locator('app-view-switcher [aria-label="Save view"]')).toHaveCount(0);

    // The one Layout menu.
    await page.locator('app-view-switcher .vs-layout').click();
    const menu = page.locator('app-view-switcher .ctx-menu');
    await expect(menu.locator('button')).toHaveText(['Save layout', 'Reset to saved layout', 'Save as new view…', 'Rename view…', 'Delete view…']);
    await page.screenshot({ path: testInfo.outputPath('layout-menu.png') });
    await page.keyboard.press('Escape');
    await page.locator('.ctx-backdrop').first().click({ position: { x: 5, y: 5 } });

    // The tab menu.
    await page.locator('app-tab-bar .tab').first().click({ button: 'right' });
    const tabMenu = page.locator('app-tab-bar .ctx-menu').first();
    await expect(tabMenu).toContainText('Go to the Work view');
    await expect(tabMenu.locator('.ctx-label')).toHaveText('Show this tab in');
    await expect(tabMenu.locator('.ctx-view')).toHaveText(['✓Notes', '✓Work', 'Crew']);
    await expect(tabMenu).toContainText('Close tab');
    await expect(page.locator('app-tab-bar .ctx-sub')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('tab-menu.png') });
    await page.keyboard.press('Escape');

    // Open windows: a new note that only Work shows.
    await page.keyboard.press('Control+n');
    // The new tab opens asynchronously; `.last()` before that is plain.md.
    await expect(page.locator('app-tab-bar .tab').last()).toContainText('untitled');
    await page.locator('app-tab-bar .tab').last().click({ button: 'right' });
    await page.locator('app-tab-bar .ctx-menu .ctx-view').getByText('Work', { exact: true }).click();
    // The menu must be gone first: a right-click on its backdrop only closes it.
    await expect(page.locator('app-tab-bar .ctx-menu')).toHaveCount(0);
    await page.locator('app-tab-bar .tab').last().click({ button: 'right' });
    await page.locator('app-tab-bar .ctx-menu .ctx-view').getByText('Notes', { exact: true }).click();
    await expect(page.locator('app-tab-bar .ctx-menu')).toHaveCount(0);
    await page.locator('app-dock-strip button[data-widget="windows"]').first().waitFor();
    await expect(page.locator('app-open-windows .group b')).toHaveText(['In this view', 'In other views']);
    await expect(page.locator('app-panel-frame', { hasText: 'Open windows' }).first()).toContainText('1 here · 1 elsewhere');
    await page.screenshot({ path: testInfo.outputPath('open-windows.png') });

    // The dock strip keeps its icons on one row.
    const strip = page.locator('app-dock-strip').first();
    const tops = await strip.locator('button').evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
    expect(tops).toBe(1);
    stopEngine();
  });
});
