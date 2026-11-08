import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/**
 * The Persona page (board 7k, milestone 201) in the running app: opened
 * from the Crew tab's `Edit persona`, read from the persona's files in the
 * vault, saved as one commit through `personaPatch`. A home of its own, so
 * the plugin spawns an engine for the seeded vault and never adopts the
 * owner's.
 */
const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

test.afterAll(() => {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(engineHome, '.drey-engine', 'service.lock'), 'utf8')) as { pid?: number };
    if (typeof lock.pid === 'number') {
      process.kill(lock.pid);
    }
  } catch {
    // no engine was started, or it is already gone
  }
  fs.rmSync(engineHome, { recursive: true, force: true });
});

const persona = (title: string, role: string): string =>
  ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: qwen3-coder', '  pool: [qwen3-coder]', '  router: off', "color: '#8ecbef'", 'skills: [tdd]', 'budget: 5', '---', `Who ${title} is.`, ''].join('\n');

test.use({
  seedVault: {
    'tickets/_meta/pipeline.md': ['---', 'phases:', '  - { id: inbox, title: Inbox, handover: manual }', '  - { id: build, title: Build, handover: agent build-default, persona: ben }', '  - { id: done, title: Done, handover: none }', '---', 'The phases.', ''].join('\n'),
    'tickets/_meta/repos.md': ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n'),
    'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder'),
    'tickets/_meta/personas/ben/prompt.md': 'You are Ben.\n',
    'tickets/_meta/personas/ben/improvements.md': ['# Improvements — ben', '', '- imp-1 open prompt.md — Add a line about the ADR index', "  - proposed: '2026-11-02T10:00:00Z'", '  - evidence:', '    - 2026-11-01 · T-0007 · guessed a convention', '  - content:', '      You are Ben, who reads the ADR index.', ''].join('\n'),
    'tickets/_meta/personas/ralf/persona.md': persona('Ralf', 'reviewer'),
    'tickets/10-inbox/T-0001.md': ['---', 'id: T-0001', 'title: "A seeded ticket"', 'repo: drey', 'priority: normal', 'branch: t/T-0001', "entered-inbox: '2026-10-20T09:00:00Z'", '---', '', '## Description', '', 'Text.', '', '## Log', ''].join('\n'),
  },
  appConfig: { plugins: { disabled: ['sample', 'templates', 'browser', 'drawio', 'ocr', 'meeting'] }, spellcheck: { enabled: false } },
});

test.beforeEach(({ vaultDir }) => {
  execFileSync('git', ['init', '-q'], { cwd: vaultDir, windowsHide: true });
  // Ralf's prompt.md cannot be read: a directory stands where the file belongs.
  fs.mkdirSync(path.join(vaultDir, 'tickets', '_meta', 'personas', 'ralf', 'prompt.md'), { recursive: true });
});

async function openPersona(page: Page, id: string): Promise<void> {
  await expect(page.locator('app-titlebar [role="tab"]', { hasText: 'Work' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Control+2');
  await page.locator('app-panel-frame', { has: page.locator('.tickets-panel') }).filter({ visible: true }).locator('.head').hover();
  await page.locator('button[aria-label="More actions"]:visible').click({ force: true });
  await page.getByRole('menuitem', { name: 'Crew', exact: true }).click();
  await page.locator(`.desk-team [data-persona="${id}"]`).first().click();
  await page.locator('.desk-detail-head .persona-edit-btn').click();
  await expect(page.locator('.persona-page .persona-text').filter({ visible: true })).toBeVisible({ timeout: 15_000 });
}

test('edit, discard and save a persona as one commit', async ({ page, vaultDir }) => {
  test.setTimeout(120_000);
  await openPersona(page, 'ben');
  const dir = path.join(vaultDir, 'tickets', '_meta', 'personas', 'ben');
  const body = page.locator('.persona-page').filter({ visible: true });
  const text = body.locator('.persona-text');
  const state = body.locator('.persona-head > .persona-muted');

  await expect(page.locator('app-tab-bar .tab', { hasText: 'Ben · persona' })).toBeVisible();
  await expect(text).toHaveValue('You are Ben.\n');
  await expect(body.locator('.persona-head-name')).toHaveText('Ben');
  await expect(body.locator('[data-field="role"]')).toHaveValue('Builder');
  await expect(body.locator('.persona-step-on')).toHaveText('✓ Build');
  await expect(state).toHaveText('Saved');
  for (const absent of ['Allowed to', 'Tell me when', 'Upload picture', 'tokens at start']) {
    await expect(body).not.toContainText(absent);
  }

  // The draft survives leaving the tab; Discard returns to the file.
  await text.fill('A draft');
  await expect(state).toHaveText('Changed · not saved');
  await page.locator('app-tab-bar .tab', { hasText: 'Crew' }).first().click();
  await page.locator('app-tab-bar .tab', { hasText: 'Ben · persona' }).click();
  await expect(page.locator('.persona-page .persona-text').filter({ visible: true })).toHaveValue('A draft');
  await body.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(text).toHaveValue('You are Ben.\n');
  expect(fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8')).toBe('You are Ben.\n');

  // Save: both files in one commit, the tab follows the new name.
  const before = Number(execFileSync('git', ['rev-list', '--count', '--all'], { cwd: vaultDir, encoding: 'utf8', windowsHide: true }).trim());
  await body.locator('[data-field="title"]').fill('Benno');
  await text.fill('You are Benno.\n');
  await body.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(state).toHaveText('Saved', { timeout: 15_000 });
  await expect(page.locator('app-tab-bar .tab', { hasText: 'Benno · persona' })).toBeVisible();
  expect(fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8')).toBe('You are Benno.\n');
  expect(fs.readFileSync(path.join(dir, 'persona.md'), 'utf8')).toContain('title: Benno');
  expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: vaultDir, encoding: 'utf8', windowsHide: true }).trim()).toBe('personas: ben updated');
  expect(execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: vaultDir, encoding: 'utf8', windowsHide: true })).toContain('prompt.md');
  expect(Number(execFileSync('git', ['rev-list', '--count', '--all'], { cwd: vaultDir, encoding: 'utf8', windowsHide: true }).trim())).toBe(before + 1);

  // A role the engine does not know: its refusal, the draft kept, nothing written.
  await body.locator('[data-field="role"]').fill('Wizard');
  await body.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(state).toContainText('the role is one of');
  await expect(body.locator('[data-field="role"]')).toHaveValue('Wizard');
  expect(fs.readFileSync(path.join(dir, 'persona.md'), 'utf8')).toContain('role: builder');
  await body.getByRole('button', { name: 'Discard', exact: true }).click();

  // The Friction card: Dismiss is written to the proposals file.
  await expect(body.locator('.persona-friction')).toContainText('Suggested change from Friction · 1');
  await body.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(body.locator('.persona-friction')).toHaveCount(0, { timeout: 15_000 });
  expect(fs.readFileSync(path.join(dir, 'improvements.md'), 'utf8')).toContain('imp-1 dismissed');

  // Back to Crew.
  await body.getByRole('button', { name: 'Back to Crew', exact: true }).click();
  await expect(page.locator('.desk-team').filter({ visible: true })).toBeVisible();
});

test('a prompt that cannot be read leaves the editor and Save disabled', async ({ page }) => {
  test.setTimeout(120_000);
  await openPersona(page, 'ralf');
  const body = page.locator('.persona-page').filter({ visible: true });
  await expect(body.locator('.persona-text')).toBeDisabled();
  await expect(body.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(body.locator('.persona-head > .persona-muted')).toContainText('Could not read the instructions');
});
