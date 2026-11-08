import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/drey';

// Drey Service is one process per user (`~/.drey-engine/service.lock`):
// without a home of its own this test would talk to the owner's live engine
// and board. A home of its own makes the plugin spawn an engine for the
// seeded vault (this checkout's build).
const engineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'drey-e2e-home-'));
process.env['USERPROFILE'] = engineHome;
process.env['HOME'] = engineHome;

/**
 * The Assistant's conversation targets (E13-5): the Model target answers
 * from the endpoint registered in Settings, Mission Control answers through
 * the engine's chat (the same endpoint, an intent envelope), a proposal card
 * waits for the owner, a 1:1 appends to the persona's thread. The model is
 * a mock OpenAI-compatible endpoint on a fixed local port; the screenshots
 * in the test output are the evidence the changelog entry names.
 */

const PORT = 41871;
const MODEL_ANSWER = 'The model says: plain chat works, no tools involved.';
const MC_SAY = 'I can create that ticket. Confirm and it lands in the inbox.';

const requests: { body: Record<string, unknown> }[] = [];

function reply(text: string): string {
  return JSON.stringify({
    id: 'mock-1',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });
}

/** The mock model: an envelope for Mission Control's turns (the prompt asks for JSON), plain text otherwise. */
function answerFor(body: Record<string, unknown>): string {
  const messages = (body['messages'] as { role: string; content: unknown }[] | undefined) ?? [];
  const text = messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  if (text.includes('"say"')) {
    return JSON.stringify({
      say: MC_SAY,
      commands: [
        {
          kind: 'createTicket',
          title: 'Dark mode for the PDF export',
          description: 'Export the PDF with the dark theme when the owner asks for it.',
          priority: 'normal',
          phase: 'inbox',
        },
      ],
    });
  }
  return MODEL_ANSWER;
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
    requests.push({ body });
    const text = answerFor(body);
    if (body['stream'] === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id: 'mock-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '' }, null));
      res.write(chunk({ content: text }, null));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(reply(text));
  });
});

test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

/** Stops the engine this test's Drey spawned (it outlives Drey by design and would hold the app open). */
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

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  stopEngine();
  fs.rmSync(engineHome, { recursive: true, force: true });
});

const PIPELINE = [
  '---',
  'phases:',
  '  - { id: inbox, title: Inbox, handover: manual }',
  '  - { id: plan, title: Plan, handover: agent plan-default, persona: paul }',
  '  - { id: build, title: Build, handover: agent build-default, persona: ben }',
  '  - { id: done, title: Done, handover: none }',
  '---',
  'The phases.',
  '',
].join('\n');

const REPOS = ['---', 'repos:', '  drey:', '    url: https://example.invalid/drey.git', '    branch: main', '---', ''].join('\n');

function persona(title: string, role: string, color: string): string {
  return ['---', `title: ${title}`, `role: ${role}`, 'worker: opencode', 'models:', '  default: mock-model', '  pool: [mock-model]', '  router: off', `color: '${color}'`, 'skills: []', 'budget: 3', '---', `Who ${title} is.`, ''].join('\n');
}

const SEED = {
  'tickets/_meta/pipeline.md': PIPELINE,
  'tickets/_meta/repos.md': REPOS,
  'tickets/_meta/personas/paul/persona.md': persona('Paul', 'planner', '#a78bfa'),
  'tickets/_meta/personas/ben/persona.md': persona('Ben', 'builder', '#3b82f6'),
};

const LLM = (provider: string) => ({
  llm: { enabled: true, provider, baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKey: null, model: 'mock-model' },
});

test.describe('Assistant conversation targets (E13-5)', () => {
  test.use({ seedVault: SEED, appConfig: LLM('openai-compat') });

  test('Model, Mission Control and a 1:1 answer from the registered endpoint', async ({ page }, testInfo) => {
    const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
    const switcher = panel.locator('.assistant-targets');
    // The tickets plugin registers its targets when it activates.
    await expect(switcher.locator('.assistant-target')).toHaveCount(3, { timeout: 30_000 });
    await expect(switcher.locator('.assistant-target.on')).toHaveAttribute('aria-label', 'Model');

    // --- Model: plain chat from the endpoint in Settings
    const input = panel.locator('.composer-input .cm-content');
    await input.click();
    await page.keyboard.type('What is a dock panel?');
    await page.keyboard.press('Enter');
    await expect(panel.locator('.assistant-thread').first()).toContainText(MODEL_ANSWER, { timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath('target-model.png') });

    // --- Mission Control: the engine's chat, a proposal card waits for the owner
    await switcher.getByLabel('Mission Control', { exact: true }).click();
    await expect(switcher.locator('.assistant-target.on')).toHaveAttribute('aria-label', 'Mission Control');
    await input.click();
    await page.keyboard.type('New ticket: dark mode for the PDF export');
    await page.keyboard.press('Enter');
    const thread = panel.locator('.target-thread');
    await expect(thread).toContainText(MC_SAY, { timeout: 60_000 });
    const card = thread.locator('.target-card');
    await expect(card).toContainText('Dark mode for the PDF export');
    await expect(card.locator('.target-card-btn')).toHaveText(['Confirm', 'Dismiss']);
    await page.screenshot({ path: testInfo.outputPath('target-mission-control.png') });
    await card.locator('.target-card-btn', { hasText: 'Dismiss' }).click();
    await expect(card).toContainText('Dismissed');
    await expect(card.locator('.target-card-btn')).toHaveCount(0);

    // --- 1:1: the group opens a menu of the team's agent personas
    await switcher.getByLabel('1:1', { exact: true }).click();
    await switcher.locator('.assistant-target-item', { hasText: 'Paul' }).click();
    await expect(switcher.locator('.assistant-target.on')).toHaveAttribute('aria-label', '1:1 · Paul');
    await input.click();
    await page.keyboard.type('Keep the plans short.');
    await page.keyboard.press('Enter');
    await expect(thread).toContainText('Keep the plans short.', { timeout: 30_000 });
    await expect(thread).toContainText('Paul reads this thread before the next run.');
    await page.screenshot({ path: testInfo.outputPath('target-one-to-one.png') });

    // Back on the model the old chat is still there, the target view is gone.
    await switcher.getByLabel('Model', { exact: true }).click();
    await expect(thread).toBeHidden();
    stopEngine();
  });
});

test.describe('Assistant conversation targets with a CLI provider (E13-5, D-1)', () => {
  test.use({ seedVault: SEED, appConfig: LLM('claude-code') });

  test('Mission Control shows the engine refusal instead of a reply', async ({ page }, testInfo) => {
    const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
    const switcher = panel.locator('.assistant-targets');
    await expect(switcher.locator('.assistant-target')).toHaveCount(3, { timeout: 30_000 });
    await switcher.getByLabel('Mission Control', { exact: true }).click();
    const input = panel.locator('.composer-input .cm-content');
    await input.click();
    await page.keyboard.type('Hello?');
    await page.keyboard.press('Enter');
    const error = panel.locator('.target-thread .target-error');
    await expect(error).toBeVisible({ timeout: 60_000 });
    await expect(error.locator('.target-error-title')).toContainText('could not answer');
    await page.screenshot({ path: testInfo.outputPath('target-cli-refused.png') });
    stopEngine();
  });
});
