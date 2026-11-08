import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

// A home of its own, so the plugin spawns an engine for the seeded vault
// instead of adopting the owner's live one (see desk-board-team.spec.ts).
const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

/**
 * The Parts block in the ticket (E13-10, board 7c): the plan's `### Parts` as
 * cards, a persona pick and a delete as engine edits that end in the file, the
 * block gone under the caret's raw Markdown, no Accept in the ticket.
 */
const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: shaping, title: Shaping, handover: manual }',
  '  - { id: prioritized, title: Prioritized, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, persona: paul }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben, claim: true }',
  '  - { id: ready, title: Ready to try, handover: manual }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const persona = (title: string, role: string): string =>
  ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: sonnet', '  pool: [sonnet]', '  router: off', "color: '#6fa58f'", 'skills: []', '---', '', `Who ${title} is.`, ''].join('\n');

const TICKET = [
  '---',
  'id: T-0130',
  'title: "Voice capture for tickets"',
  'repo: drey',
  "entered-shaping: '2026-11-04T10:05:00Z'",
  '---',
  '',
  '## Plan',
  '',
  '### Goal',
  '',
  'Press one hotkey and speak.',
  '',
  '### Parts',
  '',
  '- [ ] Capture hotkey and window',
  '  persona: ben',
  '  reason: Mod+Alt+T, focus handling',
  '- [ ] Dictation hand-off',
  '  persona: ben',
  '- [ ] Ticket from transcript',
  '  persona: ben',
  '',
].join('\n');

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': PIPELINE,
    'tickets/_meta/repos.md': ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n'),
    'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder'),
    'tickets/_meta/personas/tessa/persona.md': persona('Tessa', 'builder'),
    'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner'),
    'tickets/20-shaping/T-0130.md': TICKET,
  },
});

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

test('the plan to accept in the ticket: cards, persona pick and delete through the engine', async ({ page, vaultDir }) => {
  test.setTimeout(120_000);
  const file = path.join(vaultDir, 'tickets', '20-shaping', 'T-0130.md');
  await page.getByText('tickets', { exact: true }).first().click();
  await page.getByText('20-shaping', { exact: true }).first().click();
  await page.getByText('T-0130.md', { exact: true }).first().dblclick();

  const block = page.locator('app-editor .tickets-parts');
  await expect(block).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('app-editor .tickets-doc-status')).toHaveText('Plan to accept');
  await expect(block.locator('.tickets-parts-count')).toHaveText('3 parts');
  const rows = block.locator('.tickets-part');
  await expect(rows).toHaveCount(3);
  await expect(rows.first().locator('.tickets-part-line')).toHaveText('starts first · Mod+Alt+T, focus handling');
  await expect(rows.nth(1).locator('.tickets-part-line')).toHaveText('after P1');
  await expect(rows.first().locator('.tickets-part-state')).toContainText('Waiting');
  await expect(block.locator('.tickets-part-basis').first()).toHaveText('no estimate yet (first run)');
  // Canvas decisions 16, 28: no Accept in the ticket, only the link to the card.
  await expect(block.locator('.tickets-doc-decision-link')).toHaveText('Decision waiting · go to the card ›');
  await expect(page.locator('app-editor .tickets-parts-host')).not.toContainText('Accept plan');

  // A persona pick is an engine edit: it ends in the file.
  await rows.first().locator('.tickets-part-persona').click();
  await page.locator('.tickets-parts-menu button', { hasText: 'Tessa' }).click();
  await expect.poll(() => fs.readFileSync(file, 'utf8'), { timeout: 20_000 }).toMatch(/Capture hotkey and window\r?\n\s+persona: tessa/);
  await expect(rows.first().locator('.tickets-part-persona-name')).toHaveText('Tessa', { timeout: 20_000 });

  // A delete takes a second press.
  await rows.nth(2).locator('.tickets-part-more').click();
  await page.locator('.tickets-parts-menu button', { hasText: 'Delete part' }).click();
  expect(fs.readFileSync(file, 'utf8')).toContain('Ticket from transcript');
  await page.locator('.tickets-parts-menu button', { hasText: 'Press again to delete' }).click();
  await expect.poll(() => fs.readFileSync(file, 'utf8'), { timeout: 20_000 }).not.toContain('Ticket from transcript');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });

  // The open tab's text followed the engine's write: no conflict waits on the next save.
  await page.locator('app-editor .chrome button.source').first().click();
  await expect(page.locator('app-editor .cm-content')).toContainText('persona: tessa', { timeout: 20_000 });
  await expect(page.locator('app-editor .cm-content')).not.toContainText('Ticket from transcript');
});
