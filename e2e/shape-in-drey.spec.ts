import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

// The tickets engine is one process per user (`~/.drey-engine/engine.lock`):
// a home of its own makes the plugin spawn an engine for the seeded vault
// instead of adopting the owner's live one (see assistant-targets.spec.ts).
const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

/**
 * Shape in Drey (E13-9): an Ideas-phase ticket is open in the editor as its
 * Markdown file, the Assistant talks to Mission Control with the file
 * attached, Paul (a mock OpenAI-compatible endpoint here) writes the Plan
 * chapter, the owner edits it too and that edit rides along with the next
 * message, an answer card waits above the composer and the split proposal
 * ends the shaping. The screenshots in the test output are the evidence the
 * changelog entry names.
 */

const PORT = 41872;
const FIRST_SAY = 'I drafted the plan. One thing I cannot decide from the repository.';
const SECOND_SAY = 'Three parts it is. They ship on their own, so I would split them.';

const PLAN_ONE = [
  '### Goal',
  '',
  'Let the owner dictate a note from the quick-capture box.',
  '',
  '### Parts',
  '',
  '- [ ] Capture box records audio',
  '  persona: ben',
  '  reason: the recorder is the base of the rest',
  '- [ ] Transcribe the recording',
  '  persona: ben',
  '  reason: needs the recorder',
  '- [ ] Settings page for the language',
  '  persona: ben',
  '  reason: independent of both',
  '',
  '### Open questions',
  '',
  '- Which transport carries the audio?',
].join('\n');

const requests: { body: Record<string, unknown>; text: string }[] = [];

function envelopeFor(text: string, turn: number): string {
  if (turn === 0) {
    return JSON.stringify({
      say: FIRST_SAY,
      plan: PLAN_ONE,
      question: {
        text: 'How many parts does this need?',
        options: [
          { label: '3 parts', recommended: true },
          { label: '2 parts', recommended: false },
          { label: 'Keep it as one', recommended: false },
        ],
      },
    });
  }
  return JSON.stringify({ say: SECOND_SAY, split: { reason: 'The three parts ship and test on their own.' } });
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    const messages = (body['messages'] as { role: string; content: unknown }[] | undefined) ?? [];
    const user = [...messages].reverse().find((m) => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : '';
    const system = messages.find((m) => m.role === 'system');
    const isShape = typeof system?.content === 'string' && system.content.includes('You are Paul, the planner');
    let answer = 'The model says: nothing to shape here.';
    if (isShape) {
      requests.push({ body, text });
      answer = envelopeFor(text, requests.length - 1);
    }
    if (body['stream'] === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '' }, null));
      res.write(chunk({ content: answer }, null));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-1',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });
});

test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

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

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  stopEngine();
  fs.rmSync(engineHome, { recursive: true, force: true });
});

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: ideas, title: Ideas, handover: manual }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

const persona = (title: string, role: string, color: string): string =>
  ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: mock-model', '  pool: [mock-model]', '  router: off', `color: '${color}'`, 'skills: []', 'budget: 3', '---', '', `Who ${title} is.`, ''].join('\n');

const IDEA = [
  '---',
  'id: T-0130',
  'title: Dictate a note from the quick-capture box',
  'repo: drey',
  'priority: normal',
  'rank: 5000',
  '---',
  '',
  '## Description',
  '',
  'Say a note instead of typing it.',
  '',
  '## Plan',
  '',
  '## Log',
  '',
  "- '2026-11-04T09:00:00Z' owner — created",
  '',
].join('\n');

test.describe('Shape in Drey (E13-9)', () => {
  test.use({
    seedVault: {
      'tickets/_meta/pipeline.md': PIPELINE,
      'tickets/_meta/repos.md': REPOS,
      'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#a78bfa'),
      'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#3b82f6'),
      'tickets/10-ideas/T-0130.md': IDEA,
    },
    appConfig: {
      llm: { enabled: true, provider: 'openai-compat', baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: null, model: 'mock-model' },
    },
  });

  test('Paul writes the plan, the owner edits it too, the split ends it', async ({ page, vaultDir }, testInfo) => {
    // The ticket opens from the Files panel; its home view is Work.
    await page.getByText('tickets', { exact: true }).first().click();
    await page.getByText('10-ideas', { exact: true }).first().click();
    await page.getByText('T-0130.md', { exact: true }).first().dblclick();
    await expect(page.locator('app-editor .tickets-head')).toBeVisible({ timeout: 30_000 });
    // The Refine / Plan-with-agent buttons are gone from the header of an idea.
    await expect(page.locator('app-editor .tickets-head .tickets-head-dialog')).toHaveCount(0);

    const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
    const switcher = panel.locator('.assistant-targets');
    await expect(switcher.locator('.assistant-target')).toHaveCount(3, { timeout: 30_000 });
    await switcher.getByLabel('Mission Control', { exact: true }).click();
    await expect(panel.locator('.assistant-composer .chip.target-attached')).toHaveText('T-0130.md attached', { timeout: 15_000 });
    await expect(panel.locator('.assistant-composer .icon-btn.plus')).toBeVisible();

    // The composer keeps its Vault chip (off by default) and prompts on a target.
    await expect(panel.locator('.assistant-composer .icon-btn.vault')).toBeVisible();
    await expect(panel.locator('.assistant-composer .icon-btn.vault')).not.toHaveClass(/\bon\b/);
    await expect(panel.locator('.assistant-composer .icon-btn.live')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath('shape-composer-chips.png') });
    const input = panel.locator('.composer-input .cm-content');
    await input.click();
    await page.keyboard.type('Shape this: dictate a note from the capture box');
    await page.keyboard.press('Enter');

    // Paul's turn: the Plan chapter appears in the open document, the thread
    // carries his words (via Mission Control), the question waits above the composer.
    const thread = panel.locator('.target-thread');
    await expect(thread).toContainText(FIRST_SAY, { timeout: 60_000 });
    await expect(thread.locator('.relay-chip').first()).toContainText('via Mission Control');
    const editor = page.locator('app-editor .cm-content').first();
    await expect(editor).toContainText('Capture box records audio', { timeout: 30_000 });
    await expect(page.locator('app-editor .tickets-doc-shape-mark.is-paul').first()).toContainText('Paul edited this', { timeout: 30_000 });
    const tray = panel.locator('.target-tray');
    await expect(tray).toContainText('How many parts does this need?');
    await expect(tray.locator('.target-card-btn')).toHaveText(['3 parts', '2 parts', 'Keep it as one']);
    await page.locator('app-editor .tickets-doc-shape-marks').first().evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: testInfo.outputPath('shape-paul-edited.png') });

    // The owner edits the plan too; the mark says it rides along.
    const line = page.locator('app-editor .cm-line', { hasText: 'Which transport carries the audio?' }).first();
    await line.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' (owner: prefer a local socket)');
    await expect(page.locator('app-editor .tickets-doc-shape-mark.is-you').first()).toContainText('rides along with your next message', { timeout: 15_000 });
    await page.locator('app-editor .tickets-doc-shape-marks').first().evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: testInfo.outputPath('shape-owner-edited.png') });

    // The answer card is the next message; the owner's edit goes with it.
    await tray.locator('.target-card-btn', { hasText: '3 parts' }).click();
    await expect(thread).toContainText(SECOND_SAY, { timeout: 60_000 });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.text).toContain('The owner edited the plan');
    expect(requests[1]!.text).toContain('prefer a local socket');
    expect(requests[1]!.text.trimEnd().endsWith('3 parts')).toBe(true);
    // Paul's own edit was not mirrored back; the edit was saved before the message went out.
    const onDisk = fs.readFileSync(path.join(vaultDir, 'tickets', '10-ideas', 'T-0130.md'), 'utf8');
    expect(onDisk).toContain('prefer a local socket');
    await expect(page.locator('app-editor .tickets-doc-shape-mark.is-you')).toHaveCount(0);

    // The split proposal; "Keep as one ticket" moves the ticket into the build queue.
    const card = thread.locator('.target-card', { hasText: 'Split into 3 tickets' });
    await expect(card.locator('.target-card-btn')).toHaveText(['Split', 'Keep as one']);
    await page.screenshot({ path: testInfo.outputPath('shape-split-proposal.png') });
    await card.locator('.target-card-btn', { hasText: 'Keep as one' }).click();
    await expect.poll(() => fs.existsSync(path.join(vaultDir, 'tickets', '20-build', 'T-0130.md')), { timeout: 30_000 }).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('shape-kept.png') });
    // The chat list sits inside the panel: the shape chat is in it, current.
    await panel.locator('.assistant-head .chat-switch').click();
    const rowsList = panel.locator('.assistant-chatlist-row');
    await expect(rowsList.first()).toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('.assistant-chatlist-row.current')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('shape-chat-list.png') });
    stopEngine();
  });
});
