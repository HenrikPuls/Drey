import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/**
 * The assistant's tool loop and vault tools end to end (milestones 76 and
 * 77, ADR-0071), against a scripted OpenAI-compatible endpoint that
 * answers with tool calls: a call to a tool that was not offered is
 * refused instead of run, an offered one runs and its result reaches the
 * model, the panel shows the calls while they run, a call written into
 * the reply text is read, `vault_edit` changes a note on disk — and with
 * the Vault chip off the model is offered no vault tool at all.
 */

const MOCK_PORT = 27320;
const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

const NOTE = ['# Harbour', '', 'The harbour fee is 12 euros per night.', ''].join('\n');
const ANSWER = 'The harbour fee is 12 euros per night.';

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
    if (last?.role === 'tool') {
      // Held back for a moment so the running chips are observable.
      reply(res, { content: ANSWER }, 1200);
      return;
    }
    const question = typeof last?.content === 'string' ? last.content : '';
    const offered = JSON.stringify(body.tools);
    if (question.includes('Which tools')) {
      reply(res, { content: offered.includes('vault_read') ? 'VAULT TOOLS OFFERED' : 'NO VAULT TOOLS' });
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

async function ask(page: Page, question: string): Promise<void> {
  const panel = page.locator('app-panel-frame', { has: page.locator('.assistant-panel') });
  await expect(panel.locator('.assistant-head .chat-label')).toBeVisible();
  await panel.locator('.assistant-composer .composer-input .cm-content').click();
  await page.keyboard.type(question);
  await page.keyboard.press('Enter');
}

test.describe('Assistant tool loop', () => {
  test.use({
    seedVault: { 'notes/harbour.md': NOTE },
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

  test('with the Vault chip off the model is offered no vault tool', async ({ page }) => {
    await ask(page, 'Which tools do you have?');
    const thread = page.locator('.assistant-panel .assistant-thread');

    await expect(thread).toContainText('NO VAULT TOOLS', { timeout: 30_000 });
  });

  test('with the Vault chip on the vault tools are offered', async ({ page }) => {
    await vaultChipOn(page);
    await ask(page, 'Which tools do you have?');
    const thread = page.locator('.assistant-panel .assistant-thread');

    await expect(thread).toContainText('VAULT TOOLS OFFERED', { timeout: 30_000 });
  });
});
