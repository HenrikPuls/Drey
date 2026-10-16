import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/**
 * The assistant's tool loop and vault tools end to end (milestones 76 to
 * 78, ADR-0071), against a scripted OpenAI-compatible endpoint that
 * answers with tool calls: a call to a tool that was not offered is
 * refused instead of run, an offered one runs and its result reaches the
 * model, the panel shows the calls while they run, a call written into
 * the reply text is read, `vault_edit` changes a note on disk — and with
 * the Vault chip off the model reaches the attached note and nothing else
 * of the vault. The open note is changed with the same tool: through its
 * tab, unsaved text included, and in live edit without saving. With the
 * chip on, the sections that contain the question's words ride the system
 * prompt (milestone 80, ADR-0072).
 */

const MOCK_PORT = 27320;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

const NOTE = ['# Harbour', '', 'The harbour fee is 12 euros per night.', ''].join('\n');
const ANSWER = 'The harbour fee is 12 euros per night.';
const BERTH = ['# Berth', '', 'The berth fee is 20 euros per night.', ''].join('\n');
const RELATIVITY = ['# Relativity', '', 'Einstein published four papers in 1905.', ''].join('\n');

interface WireMessage {
  role: string;
  content: unknown;
}

function reply(res: http.ServerResponse, message: Record<string, unknown>, delayMs = 0): void {
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
  }, delayMs);
}

const readCall = (id: string): Record<string, unknown> => ({
  id,
  type: 'function',
  function: { name: 'vault_read', arguments: JSON.stringify({ path: 'notes/harbour.md' }) },
});

function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '';
  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'tool-model' }] }));
    return;
  }
  if (req.method === 'GET' && url.startsWith('/search?')) {
    const query = new URL(url, MOCK_BASE_URL).searchParams.get('q') ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        results: [
          {
            title: `Tide tables for ${query}`,
            url: 'https://tides.example/table',
            content: 'High water at 14:20.',
          },
        ],
      }),
    );
    return;
  }
  if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end();
    return;
  }
  let raw = '';
  req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
  req.on('end', () => {
    const body = JSON.parse(raw) as { messages: WireMessage[]; tools?: unknown[] };
    const last = body.messages.at(-1);
    // The chat-title call and anything else without tools: a plain reply.
    if (body.tools === undefined) {
      const asked = typeof last?.content === 'string' && last.content.includes('Which tools');
      reply(res, { content: asked ? 'NO VAULT TOOLS' : 'Harbour fee' });
      return;
    }
    if (last?.role === 'tool' && typeof last.content === 'string' && last.content.includes('Tide tables')) {
      reply(res, { content: 'High water is at 14:20.' });
      return;
    }
    if (last?.role === 'tool') {
      // Held back for a moment so the running chips are observable.
      reply(res, { content: ANSWER }, 1200);
      return;
    }
    const question = typeof last?.content === 'string' ? last.content : '';
    const offered = JSON.stringify(body.tools);
    if (question.includes('Einstein')) {
      // Answers from the system prompt alone: the context block names the note.
      const first = body.messages[0]?.content;
      const system = typeof first === 'string' ? first : '';
      reply(res, {
        content:
          system.includes('VAULT CONTEXT') &&
          system.includes('physics/relativity.md — Relativity') &&
          system.includes('four papers in 1905')
            ? 'CONTEXT RECEIVED'
            : 'NO CONTEXT',
      });
      return;
    }
    if (question.includes('Which tools')) {
      reply(res, {
        content: offered.includes('vault_search')
          ? 'VAULT TOOLS OFFERED'
          : offered.includes('vault_edit')
            ? 'DOCUMENT TOOLS ONLY'
            : 'NO VAULT TOOLS',
      });
      return;
    }
    if (question.includes('high water')) {
      // Searches only when the tool was offered: the Web chip decides.
      reply(
        res,
        offered.includes('web_search')
          ? {
              content: null,
              tool_calls: [
                {
                  id: 'w1',
                  type: 'function',
                  function: { name: 'web_search', arguments: JSON.stringify({ query: 'harbour tides' }) },
                },
              ],
            }
          : { content: 'NO WEB TOOLS' },
      );
      return;
    }
    if (question.includes('Raise the fee')) {
      reply(res, {
        content: null,
        tool_calls: [
          {
            id: 'e1',
            type: 'function',
            function: {
              name: 'vault_edit',
              arguments: JSON.stringify({
                path: 'notes/harbour.md',
                edits: [{ old_text: '12 euros', new_text: '14 euros' }],
              }),
            },
          },
        ],
      });
      return;
    }
    if (question.includes('shorter')) {
      // The document's name comes from the message: a tab that was never
      // saved has no path of its own to script against.
      const name = /DOCUMENT \((.+?)\):/.exec(question)?.[1] ?? '';
      reply(res, {
        content: null,
        tool_calls: [
          {
            id: 's1',
            type: 'function',
            function: {
              name: 'vault_edit',
              arguments: JSON.stringify({
                path: name,
                edits: [{ old_text: 'a very long sentence', new_text: 'a short one' }],
              }),
            },
          },
        ],
      });
      return;
    }
    if (question.includes('berth fee')) {
      reply(res, {
        content: null,
        tool_calls: [
          {
            id: 'b1',
            type: 'function',
            function: {
              name: 'vault_edit',
              arguments: JSON.stringify({
                path: 'berth.md',
                edits: [{ old_text: '20 euros', new_text: '25 euros' }],
              }),
            },
          },
        ],
      });
      return;
    }
    if (question.includes('in text form')) {
      reply(res, {
        content: `<tool_call>${JSON.stringify({
          name: 'vault_read',
          arguments: { path: 'notes/harbour.md' },
        })}</tool_call>`,
      });
      return;
    }
    reply(res, {
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'vault_wipe', arguments: '{}' },
        },
        readCall('c2'),
      ],
    });
  });
}

const server = http.createServer(handler);
// Playwright loads the spec module more than once per worker; the first
// listener wins and serves them all. Anything but EADDRINUSE is real.
server.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
});
server.listen(MOCK_PORT, '127.0.0.1');

/** Every chat note the vault holds, concatenated. */
function chatNotes(vaultDir: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        out.push(fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(path.join(vaultDir, 'chats'));
  return out.join('\n');
}

/** Turns the Vault chip on for the active vault: the vault tools ride only then. */
async function vaultChipOn(page: Page): Promise<void> {
  const button = page.locator('.assistant-panel .composer-meta .vault');
  await button.click();
  await page.locator('.assistant-picker .assistant-picker-row', { hasText: 'Active vault' }).click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Opens the note at the vault root in the editor: the assistant attaches it to the next question. */
async function openBerth(page: Page): Promise<void> {
  await page.locator('app-dock[side="left"] .node.file', { hasText: 'berth.md' }).click();
  await expect(page.locator('app-editor .cm-content')).toContainText('20 euros');
}

async function ask(page: Page, question: string): Promise<void> {
  const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
  await expect(panel.locator('.assistant-head .chat-label')).toBeVisible();
  await panel.locator('.assistant-composer .composer-input .cm-content').click();
  await page.keyboard.type(question);
  await page.keyboard.press('Enter');
}

test.describe('Assistant tool loop', () => {
  test.use({
    seedVault: {
      'notes/harbour.md': NOTE,
      'berth.md': BERTH,
      'physics/relativity.md': RELATIVITY,
    },
    appConfig: {
      llm: {
        enabled: true,
        provider: 'openai-compat',
        baseUrl: MOCK_BASE_URL,
        apiKey: null,
        model: 'tool-model',
      },
      tools: {
        // Writing without the dialog: the edit test asserts on the file.
        vault: { write: 'auto' },
        // One group stays on, so an ask with the chip off still carries
        // tools — and the test below can see that none of them is a vault tool.
        tasks: { enabled: true },
        templates: { enabled: false, write: 'auto' },
        webFetch: { enabled: false, approval: 'ask' },
        // A SearXNG "instance" served by the mock below: the search runs
        // for real, against this machine only.
        webSearch: {
          enabled: true,
          provider: 'searxng',
          apiKey: '',
          baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
          approval: 'allow',
        },
        servers: [],
      },
    },
  });

  test('runs an offered tool, refuses one that was not offered, and shows both while running', async ({
    page,
    vaultDir,
  }) => {
    await vaultChipOn(page);
    await ask(page, 'What is the harbour fee?');
    const thread = page.locator('.assistant-panel .assistant-thread');

    // While the model is still working: the calls made so far.
    const running = thread.locator('.card.streaming .tool-chip.running');
    await expect(running.filter({ hasText: 'vault_read' })).toBeVisible({ timeout: 30_000 });
    await expect(running.filter({ hasText: 'vault_wipe' })).toHaveCount(0);

    await expect(thread).toContainText(ANSWER, { timeout: 30_000 });
    await expect(thread.locator('.card.streaming')).toHaveCount(0);

    // The note keeps the whole exchange: the refusal and the file the tool read.
    await expect
      .poll(() => chatNotes(vaultDir), { timeout: 10_000 })
      .toContain('there is no tool \\"vault_wipe\\"');
    const note = chatNotes(vaultDir);
    expect(note).toContain('vault_read');
    expect(note).toContain('The harbour fee is 12 euros per night.');
  });

  test("the Vault chip puts the sections that contain the question's words into the prompt", async ({
    page,
    vaultDir,
  }) => {
    await vaultChipOn(page);
    await ask(page, 'What do I know about Einstein?');
    const thread = page.locator('.assistant-panel .assistant-thread');

    await expect(thread).toContainText('CONTEXT RECEIVED', { timeout: 30_000 });
    await expect(thread.locator('.context-chip')).toContainText('vault context · 1 section');
    // The turn cites what it was given.
    await expect
      .poll(() => chatNotes(vaultDir), { timeout: 10_000 })
      .toContain('"path":"physics/relativity.md"');
  });

  test('reads a tool call the model wrote into its reply text', async ({ page, vaultDir }) => {
    await vaultChipOn(page);
    await ask(page, 'What is the harbour fee? Answer in text form.');
    const thread = page.locator('.assistant-panel .assistant-thread');

    await expect(thread).toContainText(ANSWER, { timeout: 30_000 });
    await expect.poll(() => chatNotes(vaultDir), { timeout: 10_000 }).toContain('vault_read');
  });

  test('vault_edit replaces exact text in a note on disk', async ({ page, vaultDir }) => {
    await vaultChipOn(page);
    await ask(page, 'Raise the fee to 14 euros.');

    const file = path.join(vaultDir, 'notes', 'harbour.md');
    await expect
      .poll(() => fs.readFileSync(file, 'utf8'), { timeout: 30_000 })
      .toContain('The harbour fee is 14 euros per night.');
    await expect.poll(() => chatNotes(vaultDir), { timeout: 10_000 }).toContain('Edited notes/harbour.md');
  });

  test('with the Vault chip off the model gets the tools for the attached note only', async ({
    page,
  }) => {
    // The app starts on today's daily note, which rides the question.
    await ask(page, 'Which tools do you have?');
    const thread = page.locator('.assistant-panel .assistant-thread');

    await expect(thread).toContainText('DOCUMENT TOOLS ONLY', { timeout: 30_000 });
  });

  test('with the Vault chip on the vault tools are offered', async ({ page }) => {
    await vaultChipOn(page);
    await ask(page, 'Which tools do you have?');
    const thread = page.locator('.assistant-panel .assistant-thread');

    await expect(thread).toContainText('VAULT TOOLS OFFERED', { timeout: 30_000 });
  });

  test('the open note is changed through its tab, unsaved text included, with the Vault chip off', async ({
    page,
    vaultDir,
  }) => {
    await openBerth(page);
    const content = page.locator('app-editor .cm-content');
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Mooring lines are extra.');

    await ask(page, 'Raise the berth fee to 25 euros.');

    await expect(content).toContainText('The berth fee is 25 euros per night.', { timeout: 30_000 });
    // The tab saved it: the change and what was typed before it are on disk.
    const file = path.join(vaultDir, 'berth.md');
    await expect.poll(() => fs.readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('25 euros');
    expect(fs.readFileSync(file, 'utf8')).toContain('Mooring lines are extra.');
  });

  test('live edit puts the change into the tab without saving it', async ({ page, vaultDir }) => {
    await openBerth(page);
    const live = page.locator('.assistant-panel .composer-meta [aria-label="Toggle live edit"]');
    await live.click();
    await expect(live).toHaveAttribute('aria-pressed', 'true');

    await ask(page, 'Raise the berth fee to 25 euros.');

    const content = page.locator('app-editor .cm-content');
    await expect(content).toContainText('The berth fee is 25 euros per night.', { timeout: 30_000 });
    const thread = page.locator('.assistant-panel .assistant-thread');
    await expect(thread).toContainText(ANSWER, { timeout: 30_000 });
    // Unsaved: the file still holds the old text until the user saves.
    const file = path.join(vaultDir, 'berth.md');
    expect(fs.readFileSync(file, 'utf8')).toContain('20 euros');

    await content.click();
    await page.keyboard.press('Control+S');
    await expect.poll(() => fs.readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('25 euros');
  });

  test('live edit works on a tab that was never saved', async ({ page, vaultDir }) => {
    await page.locator('app-editor .cm-content').click();
    await page.keyboard.press('Control+N');
    const content = page.locator('app-editor .cm-content');
    await content.click();
    await page.keyboard.type('This is a very long sentence.');
    const live = page.locator('.assistant-panel .composer-meta [aria-label="Toggle live edit"]');
    await live.click();
    await expect(live).toHaveAttribute('aria-pressed', 'true');

    await ask(page, 'Make it shorter.');

    await expect(content).toContainText('This is a short one.', { timeout: 30_000 });
    // Still a tab without a file: nothing of that name appeared in the vault.
    expect(fs.existsSync(path.join(vaultDir, 'untitled.md'))).toBe(false);
  });

  test('the Web chip decides whether a question may search the web', async ({ page, vaultDir }) => {
    const thread = page.locator('.assistant-panel .assistant-thread');
    const web = page.locator('.assistant-panel .composer-meta [aria-label="Toggle web access"]');
    // Web search is switched on in the config, so the chip exists — and is off.
    await expect(web).toBeVisible();
    await expect(web).toHaveAttribute('aria-pressed', 'false');

    await ask(page, 'When is high water?');
    await expect(thread).toContainText('NO WEB TOOLS', { timeout: 30_000 });

    await web.click();
    await expect(web).toHaveAttribute('aria-pressed', 'true');
    await ask(page, 'When is high water today?');

    await expect(thread).toContainText('High water is at 14:20.', { timeout: 30_000 });
    // The search ran against the configured provider and its result is in the note.
    await expect.poll(() => chatNotes(vaultDir), { timeout: 10_000 }).toContain('Tide tables for harbour tides');
    expect(chatNotes(vaultDir)).toContain('https://tides.example/table');
  });
});
