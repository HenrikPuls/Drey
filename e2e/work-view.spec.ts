import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

// The tickets engine is one process per user: a home of its own keeps this
// test off the owner's live engine and board (see desk-board-team.spec.ts).
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

/**
 * The Work view (E13-13, ADR-0089): the tickets plugin's preset next to
 * Notes. The switcher lists Notes | Work, Ctrl+2 switches, the Work layout
 * is the Tickets panel left, the Assistant right and the Capacity band
 * below, and opening a ticket from Notes jumps to Work.
 */
const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

function ticket(id: string, title: string): string {
  return ['---', `id: ${id}`, `title: "${title}"`, 'repo: drey', 'priority: normal', `branch: t/${id}`, "entered-inbox: '2026-10-21T09:00:00Z'", "entered-build: '2026-10-30T09:00:00Z'", '---', '', '## Description', '', `${title}.`, '', '## Log', ''].join('\n');
}

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/40-build/T-0121.md': ticket('T-0121', 'Outline: drag headings to reorder'),
    'notes/plain.md': '# A plain note\n\nNothing to do with tickets.\n',
  },
});

test.describe('The Work view (E13-13)', () => {
  test('switches between Notes and Work and opens tickets in Work', async ({ page }, testInfo) => {
    const tabs = page.locator('[role="tablist"][aria-label="Views"] [role="tab"]');
    await expect(tabs).toHaveText(['Notes', 'Work', 'Crew']);
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: testInfo.outputPath('view-notes.png') });

    // Ctrl+2 -> Work, arranged as the preset says.
    await page.keyboard.press('Control+2');
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.tickets-panel').filter({ visible: true })).toBeVisible({ timeout: 15_000 });
    // The band's content shows only on the Board and Crew tabs (E12-15).
    await expect(page.locator('.desk-capacity')).toBeHidden({ timeout: 15_000 });
    // Board 7e: the preset seeds the band's first height (SDK 1.51, fidelity ruling O7).
    await expect
      .poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('drey.dock') ?? '{}') as { views?: Record<string, { bottomH?: number }> }).views?.['tickets.work']?.bottomH))
      .toBe(103);
    await expect(page.locator('app-dock-strip button[aria-label="Show Assistant"], app-dock-strip button[aria-label="Hide Assistant"]').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('view-work.png') });

    // Ctrl+1 -> Notes again.
    await page.keyboard.press('Control+1');
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');

    // A ticket opened from Notes (here through the Files tree) stays in the current view (D-6).
    const files = page.locator('app-files-panel');
    await files.getByText('tickets', { exact: true }).click();
    await files.getByText('40-build', { exact: true }).click();
    await files.getByText('T-0121.md', { exact: true }).click();
    await expect(page.locator('app-editor .tickets-doc-strip')).toBeVisible({ timeout: 15_000 });
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: testInfo.outputPath('view-work-ticket.png') });
    stopEngine();
  });
});
