import { ActionEngine } from '../../../plugins/assistant/main/action-engine';
import { ChatEngine } from '../../../plugins/assistant/main/chat-engine';
import { ChatStore } from '../../../plugins/assistant/main/chat-store';
import { parseChatNote } from '../../../plugins/assistant/shared/chat-note';
import { MAX_EXTRA_FILES } from '../../../plugins/assistant/shared/ask';
import { DEFAULT_APP_CONFIG, normalizeAppConfig, AppConfig } from '../../../shared/app-config';
import type { LlmChatResult, ChatMessage, LlmCapabilities } from '../../../shared/llm';

/**
 * Specs for the assistant plugin's engines (`plugins/assistant/main/`).
 * Since ADR-0048 the ask flow lives in `chat-engine.ts` (chat notes +
 * full-history replay, the bug-10(b) resolution); `action-engine.ts` is
 * manual Actions only. The Angular runner ignores `plugins/**`, so plugin
 * specs live here and import the plugin sources.
 */

const DOC = '# Titel\n\nEin Absatz.\n';

// -- action engine (manual actions + summary) ------------------------------

function engineWith(reply: string | Error, options: { llm?: boolean; mcp?: boolean } = {}): {
  engine: ActionEngine;
  calls: Array<{ messages: unknown; opts: unknown }>;
} {
  const calls: Array<{ messages: unknown; opts: unknown }> = [];
  const chat = async (messages: readonly ChatMessage[], opts?: { taskId?: string }) => {
    calls.push({ messages, opts });
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  };
  const config = normalizeAppConfig({
    ...DEFAULT_APP_CONFIG,
    llm: { ...DEFAULT_APP_CONFIG.llm, enabled: options.llm !== false },
    mcp: { ...DEFAULT_APP_CONFIG.mcp, enabled: options.mcp === true },
  });
  // One enabled manual trigger over the Reformat-style user template.
  config.actions.triggers.push({
    id: 'trigger:test',
    templateId: 'template:test',
    event: 'on-save',
    confirm: false,
    enabled: true,
  });
  config.actions.templates.push({
    id: 'template:test',
    name: 'Reformat',
    prompt: 'Tidy the document.',
    resultKind: 'localized',
    builtin: null,
  });
  return { engine: new ActionEngine(() => config, chat), calls };
}

describe('assistant plugin action engine (plugins/assistant/main)', () => {
  it('a generic action returns an edit outcome with a normalized document', async () => {
    const { engine, calls } = engineWith('```\n\n# Titel\n\nNeuer Text\n```');
    const outcome = await engine.run('trigger:test', { path: 'a.md', body: DOC }, 'task-1');

    expect(outcome.kind).toBe('edit');
    if (outcome.kind !== 'edit') {
      return;
    }
    expect(outcome.name).toBe('Reformat');
    expect(outcome.path).toBe('a.md');
    expect(outcome.previewStyle).toBe('localized');
    expect(outcome.after).toBe('# Titel\n\nNeuer Text\n'); // fence stripped, trailing newline
    // The taskId is plumbed through so the renderer can cancel the call.
    expect(calls[0]?.opts).toEqual({ taskId: 'task-1' });
  });

  it('a selection-scoped action sends section and whole document', async () => {
    const { engine, calls } = engineWith(DOC);
    await engine.run('trigger:test', { path: 'a.md', body: DOC, selection: 'Ein Absatz.' });

    const user = (calls[0]?.messages as Array<{ role: string; content: string }>)[1];
    expect(user.content).toContain('SELECTED SECTION:');
    expect(user.content).toContain('WHOLE DOCUMENT:');
  });

  it('an unchanged reply is a noop, and a rejected call is an error outcome', async () => {
    const same = engineWith(DOC.trim());
    const unchanged = await same.engine.run('trigger:test', { path: 'a.md', body: DOC });
    expect(unchanged.kind).toBe('noop');

    const failing = engineWith(new Error('connection refused'));
    const failed = await failing.engine.run('trigger:test', { path: 'a.md', body: DOC });
    expect(failed.kind).toBe('error');
    if (failed.kind === 'error') {
      expect(failed.message).toBe('connection refused');
    }
  });

  it('a cancelled generation reports as a noop, not an error', async () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    const { engine } = engineWith(abort);
    const outcome = await engine.run('trigger:test', { path: 'a.md', body: DOC });
    expect(outcome.kind).toBe('noop');
    if (outcome.kind === 'noop') {
      expect(outcome.message).toBe('Generation cancelled.');
    }
  });

  it('refuses to run when the LLM master switch is off', async () => {
    const { engine, calls } = engineWith('x', { llm: false });
    const outcome = await engine.run('trigger:test', { path: 'a.md', body: DOC });
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toBe('LLM features are disabled.');
    }
    expect(calls).toHaveLength(0);
  });

  it('the on-save enumeration only lists enabled on-save triggers', () => {
    const { engine } = engineWith(DOC);
    const actions = engine.actionsForEvent('on-save');
    expect(actions.map((a) => a.triggerId)).toEqual(['trigger:test']);
    expect(actions[0]?.confirm).toBe(false);
  });
});

// -- chat engine (ADR-0048: chat notes + full replay) -----------------------

interface ChatCall {
  messages: ChatMessage[];
  opts: Record<string, unknown>;
}

interface ChatHarness {
  engine: ChatEngine;
  calls: ChatCall[];
  files: Map<string, string>;
  deltas: Array<{ taskId: string; text: string }>;
  setConfig(patch: Partial<AppConfig['llm']>): void;
  setCapabilities(caps: Partial<LlmCapabilities>): void;
}

function chatHarness(
  reply: (call: ChatCall, index: number) => LlmChatResult | Error = () => ({
    text: 'Antwort.',
  }),
  options: { llm?: boolean; mcp?: boolean } = {},
): ChatHarness {
  const calls: ChatCall[] = [];
  const deltas: Array<{ taskId: string; text: string }> = [];
  const files = new Map<string, string>();
  const store = new ChatStore({
    read: async (path) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`missing ${path}`);
      }
      return content;
    },
    writeAnnounced: async (path, content) => {
      files.set(path, content);
      return 0;
    },
    listMarkdownFiles: async () => [...files.keys()],
  });

  const llmConfig: AppConfig['llm'] = {
    ...DEFAULT_APP_CONFIG.llm,
    enabled: options.llm !== false,
    model: 'glm-4.7',
  };
  const config: AppConfig = {
    ...normalizeAppConfig({ ...DEFAULT_APP_CONFIG, llm: llmConfig }),
    mcp: { ...DEFAULT_APP_CONFIG.mcp, enabled: options.mcp === true },
  };

  const capabilities: LlmCapabilities = {
    tools: true,
    streaming: true,
    sessions: false,
    modelListing: true,
    imageAttachments: false,
  };

  const engine = new ChatEngine(
    store,
    () => config,
    async (messages, opts) => {
      const call: ChatCall = { messages: [...messages], opts: opts ?? {} };
      const index = calls.length;
      calls.push(call);
      if (opts?.onDelta !== undefined) {
        opts.onDelta('Teil');
      }
      const result = reply(call, index);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    () => capabilities,
    {
      readVaultText: async (path) => (path === 'daily/a.md' || path === 'a.md' ? '# A body' : null),
      listVaults: async () => [{ id: 'v1', name: 'Notes' }],
      resolveAssetPath: (path) => (path === 'attachments/pic.png' ? `C:/abs/${path}` : null),
      readAssetBase64: async () => 'xjaf=',
      onDelta: (taskId, text) => deltas.push({ taskId, text }),
      onLiveEdit: () => undefined,
      // The Vault chip is off in every ASK below, so this is never called;
      // it is here to satisfy the port.
      retrieveContext: async () => ({ enabled: true, minScore: 0.3, hits: [] }),
    },
  );

  return {
    engine,
    calls,
    files,
    deltas,
    setConfig(patch) {
      Object.assign(config.llm, patch);
    },
    setCapabilities(caps) {
      Object.assign(capabilities, caps);
    },
  };
}

const ASK = {
  question: 'Worum geht es?',
  note: { path: 'a.md', body: DOC } as const,
  extraFiles: [] as { path: string; body: string }[],
  images: [] as string[],
  chatPath: null as string | null,
  liveEdit: false,
  noteKey: 'v1::a.md' as string | null,
  vaultScope: 'off' as const,
};

describe('assistant plugin chat engine — persistence (bug-10b)', () => {
  it('creates a chat note on a null chatPath and persists both turns', async () => {
    const h = chatHarness();
    const { chatPath, outcome } = await h.engine.ask(ASK, 'task-1');

    expect(outcome).toEqual({ kind: 'answer', text: 'Antwort.' });
    expect(chatPath).toMatch(/^chats\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-worum-geht-es\.md$/);
    const view = parseChatNote(h.files.get(chatPath)!);
    expect(view.frontmatter.kind).toBe('chat');
    expect(view.frontmatter.model).toBe('glm-4.7');
    // The chat is bound to the focused document (the `noteKey` doc key).
    expect(view.frontmatter.note).toBe('v1::a.md');
    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]).toMatchObject({ role: 'user', text: 'Worum geht es?' });
    expect(view.turns[1]).toMatchObject({ role: 'assistant', text: 'Antwort.' });
    expect(view.turns[1].meta.model).toBe('glm-4.7');
    expect(view.turns[1].meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('a null noteKey creates an unbound chat (no note: frontmatter)', async () => {
    const h = chatHarness();
    const { chatPath } = await h.engine.ask({ ...ASK, noteKey: null });
    const view = parseChatNote(h.files.get(chatPath)!);
    expect(view.frontmatter.note).toBeNull();
  });

  it('continues the given chatPath and full-replays the persisted history', async () => {
    const h = chatHarness();
    const first = await h.engine.ask(ASK);
    await h.engine.ask({ ...ASK, question: 'Und noch eine Frage?', chatPath: first.chatPath });

    expect(h.calls).toHaveLength(2);
    const second = h.calls[1].messages;
    // Full replay: system + prior user/assistant + the new question.
    expect(second).toHaveLength(4);
    // The prior user turn's note attachment is re-read fresh at send time
    // (paths, not bodies, are persisted).
    expect(second[1].role).toBe('user');
    expect(second[1].content).toContain('Worum geht es?');
    expect(second[1].content).toContain('FILE (a.md):\n# A body');
    expect(second[2]).toMatchObject({ role: 'assistant', content: 'Antwort.' });
    expect(second[3].content).toContain('Und noch eine Frage?');
  });

  it('replay is NOT capped — many exchanges all ride along', async () => {
    const h = chatHarness();
    let current: string | null = null;
    for (let i = 0; i < 20; i++) {
      const result = await h.engine.ask({ ...ASK, question: `Frage ${i}`, chatPath: current });
      current = result.chatPath;
    }
    // The last call replays the 19 completed exchanges (38 turns) plus
    // system + the new question = 40. Nothing is capped.
    expect(h.calls[h.calls.length - 1].messages).toHaveLength(40);
  });

  it('persists the tool trace as drey-tool entries and replays real tool pairs', async () => {
    const h = chatHarness((call, index) =>
      index === 0
        ? {
            text: 'Mit Werkzeug gefunden.',
            toolTrace: [
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 't1',
                    type: 'function',
                    function: { name: 'vault_search', arguments: '{"query":"rigg"}' },
                  },
                ],
              },
              { role: 'tool', tool_call_id: 't1', content: '3 hits' },
            ],
          }
        : { text: 'ok' },
    );
    const first = await h.engine.ask(ASK);
    // MCP off: no vault tools ride the call.
    expect(h.calls[0].opts['vaultTools']).toBeUndefined();
    await h.engine.ask({ ...ASK, question: 'Weiter?', chatPath: first.chatPath }, 'task-9');

    // The second call replays the tool loop as real message pairs (the
    // old sidecar lost them entirely — bug-10(b)).
    const second = h.calls[1].messages;
    expect(second[2]).toMatchObject({
      role: 'assistant',
      content: null,
    });
    expect((second[2] as { tool_calls?: unknown }).tool_calls).toHaveLength(1);
    expect(second[3]).toMatchObject({ role: 'tool', tool_call_id: 't1', content: '3 hits' });
    expect(second[4]).toMatchObject({ role: 'assistant', content: 'Mit Werkzeug gefunden.' });
  });

  it('forwards deltas and images per capability', async () => {
    const h = chatHarness(undefined, { mcp: true });
    h.setCapabilities({ imageAttachments: true });
    await h.engine.ask({ ...ASK, images: ['attachments/pic.png'] }, 'task-5');

    expect(h.deltas).toEqual([{ taskId: 'task-5', text: 'Teil' }]);
    expect(h.calls[0].opts).toMatchObject({ vaultTools: true });
    expect(h.calls[0].opts['attachments']).toEqual([
      { kind: 'image', mediaType: 'image/png', base64: 'xjaf=' },
    ]);
  });

  it('drops image attachments when the provider lacks the capability', async () => {
    const h = chatHarness();
    h.setCapabilities({ imageAttachments: false });
    await h.engine.ask({ ...ASK, images: ['attachments/pic.png'] });
    expect(h.calls[0].opts['attachments']).toBeUndefined();
  });

  it('re-reads note attachments fresh and warns on missing ones', async () => {
    const h = chatHarness();
    const first = await h.engine.ask({ ...ASK, note: null, extraFiles: [{ path: 'daily/a.md', body: 'live' }] });
    await h.engine.ask({ ...ASK, question: 'q2', note: null, extraFiles: [], chatPath: first.chatPath });
    const user = h.calls[1].messages[1];
    expect(user.role).toBe('user');
    expect(user.content).toContain('FILE (daily/a.md):\n# A body');
  });
});

describe('assistant plugin chat engine — sessions vs replay', () => {
  function sessionHarness(): ChatHarness {
    const h = chatHarness((call, index) =>
      index === 0 ? { text: 'eins', sessionRef: 'sess-1' } : { text: 'zwei' },
    );
    h.setCapabilities({ sessions: true });
    h.setConfig({ provider: 'claude-code' });
    return h;
  }

  it('a session provider resumes: only the new turn rides, sessionRef passed', async () => {
    const h = sessionHarness();
    const first = await h.engine.ask(ASK);
    expect(h.calls[0].opts['sessionRef']).toBeUndefined();

    await h.engine.ask({ ...ASK, question: 'zweite', chatPath: first.chatPath });
    expect(h.calls[1].opts['sessionRef']).toBe('sess-1');
    // No replay: system + new question only.
    expect(h.calls[1].messages).toHaveLength(2);
  });

  it('a provider switch mid-chat ignores the stale session and full-replays', async () => {
    const h = sessionHarness();
    const first = await h.engine.ask(ASK);
    h.setConfig({ provider: 'lmstudio' }); // session field belongs to claude-code now
    await h.engine.ask({ ...ASK, question: 'zweite', chatPath: first.chatPath });
    expect(h.calls[1].opts['sessionRef']).toBeUndefined();
    expect(h.calls[1].messages).toHaveLength(4); // system, user, assistant, new question
  });

  it('resumed session catch-up: the confirm result the session never saw', async () => {
    const edited = chatHarness(() => ({
      text: '````document\n# Geändert\n````',
      sessionRef: 'sess-9',
    }));
    edited.setCapabilities({ sessions: true });
    edited.setConfig({ provider: 'claude-code' });
    const e1 = await edited.engine.ask({ ...ASK, question: 'Ändere den Text.' });
    expect(edited.files.get(e1.chatPath)).toContain('[Proposed a change to `a.md`]');

    // Append the applied outcome (as the renderer does after confirm):
    const store = new ChatStore({
      read: async (p) => edited.files.get(p)!,
      writeAnnounced: async (p, c) => void edited.files.set(p, c),
      listMarkdownFiles: async () => [],
    });
    await store.appendEditOutcome(e1.chatPath, { path: 'a.md', applied: true, after: '# Geändert\n' });

    await edited.engine.ask({ ...ASK, question: 'weiter', chatPath: e1.chatPath });
    const user = edited.calls[1].messages[1];
    expect(user.content).toContain('was applied by the user');
    expect(user.content).toContain('INSTRUCTION / QUESTION:');
  });
});

describe('assistant plugin chat engine — failure semantics', () => {
  it('a failed generation truncates back the dangling user turn', async () => {
    const h = chatHarness(() => new Error('HTTP 500: boom'));
    await expect(h.engine.ask(ASK)).rejects.toThrow(/boom/);
    const path = [...h.files.keys()][0];
    const view = parseChatNote(h.files.get(path)!);
    expect(view.turns).toHaveLength(0);
  });

  it('a cancelled generation also leaves no dangling turn', async () => {
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    const h = chatHarness(() => abort);
    await expect(h.engine.ask(ASK)).rejects.toThrow();
    const path = [...h.files.keys()][0];
    expect(parseChatNote(h.files.get(path)!).turns).toHaveLength(0);
  });

  it('a failed resume retries once with full replay, then truncates on failure', async () => {
    let attempt = 0;
    const h = chatHarness((_call, index) => {
      if (index === 0) {
        return { text: 'eins', sessionRef: 'sess-1' };
      }
      attempt++;
      if (attempt === 1) {
        return new Error('No conversation found with session sess-1');
      }
      return { text: 'retry hat geklappt' };
    });
    h.setCapabilities({ sessions: true });
    h.setConfig({ provider: 'claude-code' });
    const first = await h.engine.ask(ASK);
    const result = await h.engine.ask({ ...ASK, question: 'zweite', chatPath: first.chatPath });
    expect(result.outcome).toEqual({ kind: 'answer', text: 'retry hat geklappt' });
    // Attempt 2 = the stale resume (sessionRef), attempt 3 = full replay.
    expect(h.calls[1].opts['sessionRef']).toBe('sess-1');
    expect(h.calls[2].opts['sessionRef']).toBeUndefined();
    expect(h.calls[2].messages).toHaveLength(4);
    const view = parseChatNote(h.files.get(first.chatPath)!);
    expect(view.turns).toHaveLength(4); // 2 exchanges, no dangling turn
  });
});

describe('assistant plugin chat engine — edit proposals', () => {
  it('an edit reply persists the proposal marker and returns the confirm outcome', async () => {
    const h = chatHarness(() => ({ text: '````document\n# Geändert\n````' }));
    const { outcome, chatPath } = await h.engine.ask({ ...ASK, question: 'Mach das anders.' });

    expect(outcome.kind).toBe('edit');
    if (outcome.kind === 'edit') {
      expect(outcome.after).toBe('# Geändert\n');
      expect(outcome.before).toBe(DOC);
      expect(outcome.summary).toBe('Mach das anders.');
    }
    const view = parseChatNote(h.files.get(chatPath)!);
    expect(view.turns[1].text).toBe('[Proposed a change to `a.md`]');

    // After the user confirms, the outcome line lands in the turn's fence:
    const store = new ChatStore({
      read: async (p) => h.files.get(p)!,
      writeAnnounced: async (p, c) => void h.files.set(p, c),
      listMarkdownFiles: async () => [],
    });
    await store.appendEditOutcome(chatPath, { path: 'a.md', applied: true, after: '# Geändert\n' });
    const updated = parseChatNote(h.files.get(chatPath)!);
    expect(updated.turns[1].tool).toEqual([
      { kind: 'edit', path: 'a.md', applied: true, after: '# Geändert\n' },
    ]);
  });

  it('the user message sends the document first, then files, and clamps the file count', async () => {
    const h = chatHarness();
    const many = Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.md`, body: 'x' }));
    await h.engine.ask({ ...ASK, extraFiles: many });
    const user = h.calls[0].messages[1];
    expect(user.content).toContain('DOCUMENT (a.md):');
    expect(String(user.content).match(/FILE \(/g)).toHaveLength(MAX_EXTRA_FILES);
  });

  it('note chip off uses the answer-only prompt and ignores a document fence', async () => {
    const h = chatHarness(() => ({ text: '````document\n# Anders\n````' }));
    const { outcome } = await h.engine.ask({ ...ASK, note: null, question: 'Was steht in b.md?' });
    const system = h.calls[0].messages[0];
    expect(system.content).toContain('no document to edit');
    // No edit target exists: the reply stays a plain answer, verbatim.
    expect(outcome).toEqual({ kind: 'answer', text: '````document\n# Anders\n````' });
  });
});

describe('assistant plugin chat engine — document-fence protocol (ADR-0053)', () => {
  it('an edit request with no usable fence degrades to a plain answer', async () => {
    const h = chatHarness(() => ({ text: 'I would rather not change the document.' }));
    const { outcome } = await h.engine.ask({ ...ASK, question: 'Mach das anders.' });
    // A prose decline streams as an answer; it is NOT a parse failure.
    expect(outcome).toEqual({ kind: 'answer', text: 'I would rather not change the document.' });
  });

  it('a document fence with inner ``` fences survives intact', async () => {
    const reply = [
      'Here is the change:',
      '````document',
      '# T',
      '```js',
      'code();',
      '```',
      '# More',
      '````',
    ].join('\n');
    const h = chatHarness(() => ({ text: reply }));
    const { outcome } = await h.engine.ask({ ...ASK, question: 'Mach das anders.' });
    expect(outcome.kind).toBe('edit');
    if (outcome.kind === 'edit') {
      expect(outcome.after).toBe('# T\n```js\ncode();\n```\n# More\n');
    }
  });

  it('a tools-ran-but-empty reply fails instead of showing an empty card', async () => {
    const h = chatHarness(() => ({
      text: '',
      toolTrace: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 't1', type: 'function', function: { name: 'vault_search', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 't1', content: '3 hits' },
      ],
    }));
    await expect(h.engine.ask(ASK)).rejects.toThrow(/no message content/);
    const path = [...h.files.keys()][0];
    expect(parseChatNote(h.files.get(path)!).turns).toHaveLength(0);
  });
});
