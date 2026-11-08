import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

// The tickets engine is one process per user: a home of its own makes the
// plugin spawn an engine for the seeded vault instead of adopting the
// owner's live one (see desk-board-team.spec.ts).
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
 * The Flow tab (E13-11) and the Settings → Tickets rows (E13-12) over a
 * seeded tickets vault: the flow is edited and saved through the engine,
 * the settings page shows the team, the standard flow, the budget and the
 * video storage. The screenshots in the test output are the evidence.
 */

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, persona: paul }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: review, title: Review, handover: agent review-default, persona: ralf }',
  '  - { id: commit, title: Commit, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

const TICKET = [
  '---',
  'id: T-0121',
  'title: "Outline: drag headings to reorder"',
  'repo: drey',
  'priority: normal',
  'branch: t/T-0121',
  "entered-inbox: '2026-10-21T09:00:00Z'",
  "entered-build: '2026-10-30T09:00:00Z'",
  '---',
  '',
  '## Description',
  '',
  'Drag a heading in the outline to move its section.',
  '',
  '## Log',
  '',
].join('\n');

function persona(title: string, role: string, color: string, budget: number): string {
  return ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: qwen3-coder', '  pool: [qwen3-coder]', '  router: off', `color: '${color}'`, 'skills: []', `budget: ${budget}`, '---', `Who ${title} is.`, ''].join('\n');
}

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': REPOS,
    'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#a78bfa', 3),
    'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#3b82f6', 5),
    'tickets/_meta/personas/ralf/persona.md': persona('Ralf', 'reviewer', '#10b981', 4),
    'tickets/40-build/T-0121.md': TICKET,
  },
});

test.describe('Flow tab and Settings → Tickets (E13-11, E13-12)', () => {
  test('edits and saves a ticket flow through the engine, then shows the settings rows', async ({ page, vaultDir }, testInfo) => {
    // --- open the ticket and its Flow tab from the chain strip
    await page.getByText('tickets', { exact: true }).first().click();
    await page.getByText('40-build', { exact: true }).first().click();
    await page.getByText('T-0121.md', { exact: true }).first().dblclick();
    const change = page.locator('app-editor .tickets-doc-flow');
    await expect(change).toBeVisible({ timeout: 20_000 });
    await change.click();

    const flow = page.locator('.flow-tab').filter({ visible: true });
    await expect(flow).toBeVisible({ timeout: 15_000 });
    await expect(flow.locator('.flow-gate-title').first()).toHaveText('Build');
    await expect(flow.locator('.flow-chip')).toHaveText('Standard flow');
    await expect(flow.getByRole('button', { name: 'Save flow' })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('flow-standard.png') });

    // --- add a manual step after Review and save it
    await flow.locator('.flow-plus[aria-label="Add a gate after Review"]').click();
    await flow.locator('.flow-add').getByRole('button', { name: 'Manual step' }).click();
    await expect(flow.locator('.flow-gate.is-added')).toBeVisible();
    await expect(flow.locator('.flow-chip')).toContainText('Standard flow + 1 change');
    await expect(flow.locator('.flow-inspector')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('flow-edited.png') });
    await flow.getByRole('button', { name: 'Save flow' }).click();
    await expect(flow.locator('.flow-message')).toContainText('Saved', { timeout: 15_000 });
    const file = fs.readFileSync(path.join(vaultDir, 'tickets', '40-build', 'T-0121.md'), 'utf8');
    expect(file).toMatch(/chain:/);
    expect(file).toContain('manual');
    await expect(flow.getByRole('button', { name: 'Save flow' })).toBeDisabled();

    // --- Settings → Tickets
    await page.locator('app-status-bar .settings').click();
    await page.locator('app-settings .category', { hasText: 'Tickets' }).click();
    const settings = page.locator('.tset-desk');
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await expect(settings.locator('.tset-set-controls').first()).toContainText('Paul, Ben, Ralf');
    await expect(settings.locator('[aria-label="Standard flow"]')).toHaveText('Plan → Build → Review');
    await expect(settings).toContainText('$12 across 3 personas');
    const videos = page.locator('[data-settings-section="videos"]');
    await expect(videos.locator('#tset-videos-limit')).not.toHaveValue('');
    await expect(videos.locator('#tset-videos-in-git')).not.toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('settings-tickets.png') });
    await videos.locator('#tset-videos-limit').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('settings-tickets-videos.png') });

    // The flow editor opens from Settings on the picked ticket (the overlay stays over it).
    await settings.getByRole('button', { name: 'Open flow editor' }).click();
    stopEngine();
  });
});
