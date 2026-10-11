import { ActionEngine } from '../../../plugins/assistant/main/action-engine';
import { ChatEngine } from '../../../plugins/assistant/main/chat-engine';
import { ChatStore } from '../../../plugins/assistant/main/chat-store';
import { parseChatNote } from '../../../plugins/assistant/shared/chat-note';
import { MAX_EXTRA_FILES } from '../../../plugins/assistant/shared/ask';
import {
  TASKS_LIST_SPEC,
  hydrateTaskRecords,
  matchTasksInAnswer,
  runTasksListTool,
  taskArgsCarryScopeRestriction,
} from '../../../plugins/assistant/main/tasks-tool';
import {
  TITLE_SYSTEM,
  buildDateNote,
  buildTitleUserMessage,
  sanitizeChatTitle,
} from '../../../plugins/assistant/main/ask-prompts';
import type { VaultExploreTools } from '../../../plugins/assistant/main/vault-explore-tools';
import type { RetrievalOutcome } from '../../../plugins/assistant/shared/semantic';
import { DEFAULT_APP_CONFIG, normalizeAppConfig, AppConfig } from '../../../shared/app-config';
import type { LlmChatResult, ChatMessage, LlmCapabilities, ToolSpec } from '../../../shared/llm';
import type { SdkTaskRecord } from '../../../shared/plugin-api';

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
    tools: {
      ...DEFAULT_APP_CONFIG.tools,
      vault: { enabled: options.mcp === true, write: 'confirm' },
    },
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
  /** The 57e chat-naming calls (background traffic, recorded separately). */
  titleCalls: ChatCall[];
  files: Map<string, string>;
  deltas: Array<{ taskId: string; text: string }>;
  /** The tasks_list tool the harness offers (null = none); replaced per test. */
  tasksTool: {
    spec: ToolSpec;
    run(argsJson: string): Promise<string>;
    query(opts?: { includeDone?: boolean; vaultId?: string }): Promise<readonly SdkTaskRecord[]>;
  } | null;
  setConfig(patch: Partial<AppConfig['llm']>): void;
  /** The live config object the engine reads -- tests flip tool groups on it. */
  config: AppConfig;
  setCapabilities(caps: Partial<LlmCapabilities>): void;
  /** The retrieval outcome the Vault chip's ask reports (ADR-0055); replaced per test. */
  retrieval: RetrievalOutcome;
  /** The explore tools the harness offers (null = semantic off); replaced per test. */
  exploreTools: VaultExploreTools | null;
}

function chatHarness(
  reply: (call: ChatCall, index: number) => LlmChatResult | Error = () => ({
    text: 'Antwort.',
  }),
  options: { llm?: boolean; mcp?: boolean; titleReply?: string | Error } = {},
): ChatHarness {
  const calls: ChatCall[] = [];
  const titleCalls: ChatCall[] = [];
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
    // The vault tool group (ADR-0063) -- `mcp.enabled` no longer steers
    // the assistant.
    tools: {
      ...structuredClone(DEFAULT_APP_CONFIG.tools),
      vault: { enabled: options.mcp === true, write: 'confirm' },
    },
  };

  const capabilities: LlmCapabilities = {
    tools: true,
    streaming: true,
    sessions: false,
    modelListing: true,
    imageAttachments: false,
  };

  const harness: ChatHarness = {
    engine: undefined as never,
    calls,
    titleCalls,
    files,
    deltas,
    tasksTool: null,
    retrieval: { enabled: true, minScore: 0.3, hits: [] },
    exploreTools: null,
    setConfig(patch) {
      Object.assign(config.llm, patch);
    },
    config,
    setCapabilities(caps) {
      Object.assign(capabilities, caps);
    },
  };

  harness.engine = new ChatEngine(
    store,
    () => config,
    async (messages, opts) => {
      const call: ChatCall = { messages: [...messages], opts: opts ?? {} };
      // The 57e naming call is background traffic: it records into its
      // own list and answers from `options.titleReply` (default a sane
      // title) — never through the test's reply fn, whose call indexes
      // and attempt counters describe the MAIN flow.
      if ((messages[0]?.content ?? '') === TITLE_SYSTEM) {
        titleCalls.push(call);
        const titled = options.titleReply ?? 'Benannter Chat';
        if (titled instanceof Error) {
          throw titled;
        }
        return { text: titled };
      }
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
      listVaults: async () => [{ id: 'v1', name: 'Notes', active: true }],
      resolveAssetPath: (path) => (path === 'attachments/pic.png' ? `C:/abs/${path}` : null),
      readAssetBase64: async () => 'xjaf=',
      onDelta: (taskId, text) => deltas.push({ taskId, text }),
      onLiveEdit: () => undefined,
      // The Vault chip is off in every ASK below, so this is never called;
      // it is here to satisfy the port.
      retrieveContext: async () => harness.retrieval,
      exploreTools: () => harness.exploreTools,
      tasksTool: () => harness.tasksTool,
      // The template tools would change the prompt shape in every ASK
      // below (SDK 1.14); these tests pin the pre-template prompts.
      templateTools: () => null,
    },
  );

  return harness;
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
  vaultIds: [] as string[],
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

  it('tool groups (ADR-0063): a group that is off rides neither the call nor the prompt', async () => {
    const h = chatHarness();
    h.tasksTool = {
      spec: { name: 'tasks_list', description: 'd', parameters: { type: 'object', properties: {} } },
      run: async () => '',
      query: async () => [],
    };
    await h.engine.ask({ ...ASK });
    expect((h.calls[0].opts['tools'] as { name: string }[]).map((t) => t.name)).toEqual(['tasks_list']);
    expect(h.calls[0].opts['vaultTools']).toBeUndefined();
    expect(h.calls[0].opts['externalTools']).toBeUndefined();

    h.config.tools.tasks.enabled = false;
    await h.engine.ask({ ...ASK });
    expect(h.calls[1].opts['tools']).toBeUndefined();
    expect(h.calls[1].messages[0].content).not.toContain('tasks_list');
  });

  it('external tools (ADR-0063): on with web fetch or a server, with the note and more rounds', async () => {
    const h = chatHarness();
    h.config.tools.webFetch.enabled = true;
    await h.engine.ask({ ...ASK });
    expect(h.calls[0].opts).toMatchObject({ externalTools: true, maxToolRounds: 8 });
    expect(h.calls[0].messages[0].content).toContain('web_fetch');

    // A provider without a tool loop gets neither the option nor the promise.
    h.setCapabilities({ tools: false });
    await h.engine.ask({ ...ASK });
    expect(h.calls[1].opts['externalTools']).toBeUndefined();
    expect(h.calls[1].messages[0].content).not.toContain('web_fetch');
  });

  it('the vault write rule reaches the prompt', async () => {
    const h = chatHarness(undefined, { mcp: true });
    await h.engine.ask({ ...ASK });
    expect(h.calls[0].messages[0].content).toContain('confirms every vault_write');
    h.config.tools.vault.write = 'auto';
    await h.engine.ask({ ...ASK });
    expect(h.calls[1].messages[0].content).toContain('applies immediately');
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

describe('assistant plugin chat engine — tasks_list tool (SDK 1.11)', () => {
  const TASK: SdkTaskRecord = {
    path: 'daily/a.md',
    vaultId: 'v1',
    line: 3,
    text: 'Aufräumen',
    done: false,
    kind: 'checkbox',
    heading: null,
    tags: [],
    due: '2026-10-02',
    priority: 'high',
  };

  it('attaches the tasks tool to a normal ask when the port provides one', async () => {
    const h = chatHarness();
    h.tasksTool = {
      spec: TASKS_LIST_SPEC,
      run: async () => `${JSON.stringify(TASK)}`,
      query: async () => [],
    };

    await h.engine.ask(ASK);

    const opts = h.calls[0]?.opts as {
      tools?: ToolSpec[];
      maxToolRounds?: number;
      onToolCall?: (name: string, args: string) => Promise<string>;
      vaultTools?: boolean;
    };
    expect(opts.tools?.map((t) => t.name)).toEqual(['tasks_list']);
    expect(opts.maxToolRounds).toBe(3);
    expect(opts.vaultTools).toBeUndefined(); // no MCP gate — the tool rides alone
    expect(await opts.onToolCall?.('tasks_list', '{}')).toContain('Aufräumen');
    expect(await opts.onToolCall?.('other_tool', '{}')).toContain('Unknown tool');
    // The system prompt tells the model to prefer the tool for task questions.
    const system = h.calls[0]?.messages[0] as { role: string; content: string };
    expect(system.content).toContain('ONLY a question about the user\'s tasks');
  });

  it('no task provider means no tool and no tasks note', async () => {
    const h = chatHarness();
    await h.engine.ask(ASK);
    const opts = h.calls[0]?.opts as { tools?: unknown };
    expect(opts.tools).toBeUndefined();
    const system = h.calls[0]?.messages[0] as { content: string };
    expect(system.content).not.toContain('ONLY a question about the user\'s tasks');
    // The wikilink note rides regardless (navigation is prompt-level, SDK 1.11).
    expect(system.content).toContain('wikilinks');
  });

  it('a live-edit turn keeps the doc tools — the tasks tool does not join', async () => {
    const h = chatHarness(() => ({ text: 'Live-Antwort.' }));
    h.tasksTool = { spec: TASKS_LIST_SPEC, run: async () => '', query: async () => [] };
    await h.engine.ask({ ...ASK, liveEdit: true, note: { path: 'a.md', body: DOC } });
    const opts = h.calls[0]?.opts as { tools?: ToolSpec[] };
    expect(opts.tools?.map((t) => t.name)).toEqual([
      'doc_apply_diff',
      'doc_write',
      'doc_read',
    ]);
  });

  it('a tool-carrying turn persists the call/result pair in the drey-tool fence', async () => {
    const h = chatHarness(() => ({
      text: 'Du hast eine offene Aufgabe.',
      toolTrace: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tk1', type: 'function', function: { name: 'tasks_list', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'tk1', content: `${JSON.stringify(TASK)}` },
      ],
    }));
    h.tasksTool = {
      spec: TASKS_LIST_SPEC,
      run: async () => `${JSON.stringify(TASK)}`,
      query: async () => [TASK],
    };

    const { chatPath } = await h.engine.ask(ASK);
    const view = parseChatNote(h.files.get(chatPath)!);
    expect(view.turns[1].tool).toEqual([
      { kind: 'call', id: 'tk1', name: 'tasks_list', arguments: '{}' },
      {
        kind: 'result',
        id: 'tk1',
        content: `${JSON.stringify(TASK)}`,
      },
    ]);
  });
});

describe('assistant plugin tasks tool — runner + hydration (SDK 1.11)', () => {
  const TASK: SdkTaskRecord = {
    path: 'daily/a.md',
    vaultId: 'v1',
    line: 3,
    text: 'Aufräumen',
    done: false,
    kind: 'checkbox',
    heading: null,
    tags: [],
    due: null,
    priority: null,
  };

  it('runTasksListTool emits one JSON line per record and a truncation note', async () => {
    const provider = {
      query: async () => Array.from({ length: 152 }, (_, i) => ({ ...TASK, line: i + 1 })),
      setDone: async () => TASK,
    };
    const out = await runTasksListTool(provider, '{}');
    const lines = out.split('\n');
    expect(lines).toHaveLength(151); // 150 rows + the truncation note
    expect(JSON.parse(lines[0])).toMatchObject({ text: 'Aufräumen', line: 1 });
    expect(JSON.parse(lines[150])).toEqual({ truncated: 2 });
  });

  it('runTasksListTool parses includeDone/vaultId and reports the empty index', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const provider = {
      query: async (opts?: Record<string, unknown>) => {
        seen.push({ ...(opts ?? {}) });
        return opts?.['includeDone'] === true ? [TASK] : [];
      },
      setDone: async () => TASK,
    };
    expect(await runTasksListTool(provider, '{"includeDone":true,"vaultId":"v1"}')).toBe(
      JSON.stringify(TASK),
    );
    // The tool always asks for the importance view (57c) unless the model
    // overrides it.
    expect(seen[0]).toEqual({ includeDone: true, vaultId: 'v1', sort: 'importance' });
    expect(await runTasksListTool(provider, 'not json')).toContain('Could not parse');
    expect(await runTasksListTool(provider, '{}')).toBe('No tasks found.');
  });

  it('runTasksListTool passes text/tag/overdue/sort intent args to the provider (57c)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const provider = {
      query: async (opts?: Record<string, unknown>) => {
        seen.push({ ...(opts ?? {}) });
        return [TASK];
      },
      setDone: async () => TASK,
    };
    await runTasksListTool(
      provider,
      '{"text":"Marta","tag":"#blockuniversum","overdue":true,"sort":"priority"}',
    );
    expect(seen[0]).toEqual({
      includeDone: false,
      text: 'Marta',
      tag: 'blockuniversum',
      overdue: true,
      sort: 'priority',
    });
    // Blank/unknown values stay unset; the # is stripped from the tag.
    await runTasksListTool(provider, '{"text":"   ","tag":"  ","overdue":false,"sort":"nope"}');
    expect(seen[1]).toEqual({ includeDone: false, sort: 'importance' });
  });

  it('hydrateTaskRecords re-resolves rows against the live index', () => {
    const persisted: SdkTaskRecord[] = [
      TASK,
      { ...TASK, line: 20, text: 'Verschoben', due: '2026-09-01', done: true },
    ];
    const current: SdkTaskRecord[] = [
      { ...TASK }, // same line
      // the shifted twin: same text, new line/due/done state
      { ...TASK, line: 12, text: 'Verschoben', due: '2026-10-31', done: false },
    ];
    const hydrated = hydrateTaskRecords(persisted, current);
    expect(hydrated[0]).toMatchObject({ line: 3, text: 'Aufräumen' });
    expect(hydrated[1]).toMatchObject({ line: 12, due: '2026-10-31', done: false });
    // No candidate — the persisted row stands.
    const ghost = hydrateTaskRecords([{ ...TASK, path: 'gone.md' }], current);
    expect(ghost[0]?.path).toBe('gone.md');
  });
});

describe('assistant plugin tasks tool — answer matching (57b)', () => {
  /** Real records from the owner's vault (meeting-import convention). */
  const MARTA: SdkTaskRecord = {
    path: 'meetings/2026-09-15-stand-notizen.md',
    vaultId: 'v1',
    line: 22,
    text: 'Marta: Notiz "Zeit in der Sprache" anlegen (Stichworte: tense logic, Aspekt, Futurum als Epistemik-Marker)',
    done: false,
    kind: 'checkbox',
    heading: 'Aufgaben',
    tags: [],
    due: '2026-09-25',
    priority: null,
  };
  const HENRIK: SdkTaskRecord = {
    path: 'meetings/2026-09-15-stand-notizen.md',
    vaultId: 'v1',
    line: 21,
    text: 'Henrik: Summarize-Test über den Tag #blockuniversum laufen lassen und Ergebnis im Lesekreis vorstellen',
    done: false,
    kind: 'checkbox',
    heading: 'Aufgaben',
    tags: ['blockuniversum'],
    due: '2026-10-02',
    priority: null,
  };

  it('the real two-sentence answer matches the tasks it paraphrases', () => {
    const answer =
      'Die wichtigsten derzeit offenen Tasks sind diejenigen mit den nächsten ' +
      'Fälligkeitsdaten: Marta muss bis zum 25.09. eine Notiz zu „Zeit in der Sprache" ' +
      'anlegen, und Henrik hat am 02.10. einen Summarize-Test über das Thema ' +
      'Blockuniversum durchzuführen.';
    const matched = matchTasksInAnswer(answer, [MARTA, HENRIK]);
    expect(matched.map((t) => t.text.slice(0, 6))).toEqual(['Marta:', 'Henrik']);
  });

  it('a prose answer about the topic (not tasks) triggers nothing', () => {
    const answer =
      'Das Blockuniversum ist eine philosophische Position über die Zeit. ' +
      'Henrik hat in der Debatte die Relativität der Gleichzeitigkeit erläutert.';
    expect(matchTasksInAnswer(answer, [HENRIK])).toEqual([]);
  });

  it('noise rows with too few significant tokens never match', () => {
    const answer = 'Der Test ist erledigt und war erfolgreich.';
    expect(matchTasksInAnswer(answer, [{ ...HENRIK, text: 'Test' }])).toEqual([]);
  });

  it('a mixed-language answer quoting the task title still matches', () => {
    // Models keep proper titles verbatim even when the surrounding prose
    // switches language — that is what the matcher anchors to. (A fully
    // translated PARAPHRASE with zero shared words stays under the
    // threshold — documented matcher limit.)
    const answer = 'Marta muss die Notiz "Zeit in der Sprache" anlegen — create it by 25.09.';
    expect(matchTasksInAnswer(answer, [MARTA]).map((t) => t.line)).toEqual([22]);
  });
});

describe('assistant plugin chat engine — post-hoc task block (57b)', () => {
  const MARTA: SdkTaskRecord = {
    path: 'meetings/2026-09-15-stand-notizen.md',
    vaultId: 'v1',
    line: 22,
    text: 'Marta: Notiz "Zeit in der Sprache" anlegen (Stichworte: tense logic, Aspekt, Futurum als Epistemik-Marker)',
    done: false,
    kind: 'checkbox',
    heading: 'Aufgaben',
    tags: [],
    due: '2026-09-25',
    priority: null,
  };
  const HENRIK: SdkTaskRecord = {
    path: 'meetings/2026-09-15-stand-notizen.md',
    vaultId: 'v1',
    line: 21,
    text: 'Henrik: Summarize-Test über den Tag #blockuniversum laufen lassen und Ergebnis im Lesekreis vorstellen',
    done: false,
    kind: 'checkbox',
    heading: 'Aufgaben',
    tags: ['blockuniversum'],
    due: '2026-10-02',
    priority: null,
  };

  function tasksHarness(
    answer: string,
    records: readonly SdkTaskRecord[],
    options: {
      /** A tasks_list call in the model's trace: its args + result content. */
      traceTasksCall?: { args: string; result?: string };
    } = {},
  ) {
    const call = options.traceTasksCall;
    const h = chatHarness(() => ({
      text: answer,
      ...(call !== undefined
        ? {
            toolTrace: [
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'real1', type: 'function', function: { name: 'tasks_list', arguments: call.args } },
                ],
              },
              {
                role: 'tool',
                tool_call_id: 'real1',
                content: call.result ?? records.map((r) => JSON.stringify(r)).join('\n'),
              },
            ],
          }
        : {}),
    }));
    const queryOpts: Array<Record<string, unknown>> = [];
    h.tasksTool = {
      spec: TASKS_LIST_SPEC,
      run: async () => records.map((r) => JSON.stringify(r)).join('\n'),
      query: async (opts?: Record<string, unknown>) => {
        queryOpts.push({ ...(opts ?? {}) });
        return records;
      },
    };
    return { h, queryOpts };
  }

  it('a task-shaped answer gets its MATCHED subset persisted as a synthetic pair', async () => {
    const answer =
      'Die wichtigsten offenen Tasks: Marta muss die Notiz "Zeit in der Sprache" anlegen.';
    const { h, queryOpts } = tasksHarness(answer, [MARTA, HENRIK]);

    const { chatPath } = await h.engine.ask(ASK);
    // The post-hoc query asks for the deterministic importance view of
    // the open set (57c).
    expect(queryOpts).toEqual([{ includeDone: false, sort: 'importance' }]);
    const view = parseChatNote(h.files.get(chatPath)!);
    const tool = view.turns[1].tool;
    expect(tool).toHaveLength(2);
    expect(tool[0]).toMatchObject({ kind: 'call', name: 'tasks_list' });
    expect(tool[1]?.kind).toBe('result');
    if (tool[1]?.kind !== 'result') {
      return;
    }
    // The block is SCOPED to what the answer discusses (57c): Marta's
    // task only — not the full index the query returned.
    const lines = tool[1].content.split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ line: 22 });
  });

  it('an answer covering the whole set keeps the full block', async () => {
    const answer =
      'Henrik soll den Summarize-Test über den Tag #blockuniversum laufen lassen und das ' +
      'Ergebnis im Lesekreis vorstellen; Marta legt die Notiz "Zeit in der Sprache" an ' +
      '(tense logic, Aspekt, Futurum als Epistemik-Marker) bis zum Stichwort.';
    const { h } = tasksHarness(answer, [MARTA, HENRIK]);
    const { chatPath } = await h.engine.ask(ASK);
    const tool = parseChatNote(h.files.get(chatPath)!).turns[1].tool;
    expect(tool[1]?.kind).toBe('result');
    if (tool[1]?.kind !== 'result') {
      return;
    }
    expect(tool[1].content.split('\n')).toHaveLength(2);
  });

  it('a non-task answer stays fence-free', async () => {
    const { h } = tasksHarness('Das Blockuniversum ist eine philosophische Position über die Zeit.', [
      MARTA,
      HENRIK,
    ]);
    const { chatPath } = await h.engine.ask(ASK);
    expect(parseChatNote(h.files.get(chatPath)!).turns[1].tool).toEqual([]);
  });

  it('no synthetic pair when the model called the tool itself', async () => {
    const answer = 'Die wichtigsten offenen Tasks: Marta muss die Notiz "Zeit in der Sprache" anlegen.';
    const { h } = tasksHarness(answer, [MARTA, HENRIK], {
      traceTasksCall: { args: '{"text":"Marta"}' },
    });
    const { chatPath } = await h.engine.ask(ASK);
    const tool = parseChatNote(h.files.get(chatPath)!).turns[1].tool;
    // Exactly the real trace pair (id real1), nothing synthetic appended —
    // and a RESTRICTED call's result is never touched.
    expect(tool.map((e) => ('id' in e ? e.id : null))).toEqual(['real1', 'real1']);
    expect(tool[1]?.kind).toBe('result');
    if (tool[1]?.kind === 'result') {
      expect(tool[1].content.split('\n')).toHaveLength(2);
    }
  });

  it('an UNRESTRICTED model call is trimmed to the answer-scoped subset (57c)', async () => {
    // The exact live failure: the model called {} on a "tasks of Henrik"
    // question and the block listed everything. The refine deterministically
    // scopes the persisted result to what the answer discusses.
    const answer =
      'Die wichtigsten Tasks von Henrik: der Summarize-Test über den Tag #blockuniversum ' +
      'läuft über den Tag und das Ergebnis wird im Lesekreis vorgestellt.';
    const { h } = tasksHarness(answer, [MARTA, HENRIK], { traceTasksCall: { args: '{}' } });
    const { chatPath } = await h.engine.ask(ASK);
    const tool = parseChatNote(h.files.get(chatPath)!).turns[1].tool;
    expect(tool.map((e) => ('id' in e ? e.id : null))).toEqual(['real1', 'real1']);
    expect(tool[1]?.kind).toBe('result');
    if (tool[1]?.kind !== 'result') {
      return;
    }
    const lines = tool[1].content.split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ line: 21 }); // Henrik
  });

  it('an unrestricted call with a whole-set answer stays untouched', async () => {
    // Both tasks named with enough of their own words — the answer IS the
    // whole scope, so the refine must not trim.
    const answer =
      'Henrik soll den Summarize-Test über den Tag #blockuniversum laufen lassen und das ' +
      'Ergebnis im Lesekreis vorstellen; Marta legt die Notiz "Zeit in der Sprache" an — ' +
      'Stichworte: tense, logic, Aspekt, Futurum als Epistemik-Marker.';
    const { h } = tasksHarness(answer, [MARTA, HENRIK], { traceTasksCall: { args: '{}' } });
    const { chatPath } = await h.engine.ask(ASK);
    const tool = parseChatNote(h.files.get(chatPath)!).turns[1].tool;
    expect(tool[1]?.kind).toBe('result');
    if (tool[1]?.kind === 'result') {
      expect(tool[1].content.split('\n')).toHaveLength(2);
    }
  });

  it('an index failure never fails the ask', async () => {
    const h = chatHarness(() => ({ text: 'Tasks: Marta muss die Notiz "Zeit in der Sprache" anlegen.' }));
    h.tasksTool = {
      spec: TASKS_LIST_SPEC,
      run: async () => '',
      query: async () => {
        throw new Error('index gone');
      },
    };
    const { outcome } = await h.engine.ask(ASK);
    expect(outcome.kind).toBe('answer');
  });

  it('a live-edit turn never gets the post-hoc pass', async () => {
    const { h } = tasksHarness('Live angewandt.', [MARTA, HENRIK]);
    const { chatPath } = await h.engine.ask({ ...ASK, liveEdit: true, note: { path: 'a.md', body: DOC } });
    const view = parseChatNote(h.files.get(chatPath)!);
    expect(view.turns[1].tool.every((e) => e.kind !== 'result' || !e.content.includes('"line":22'))).toBe(true);
  });
});

describe('assistant plugin — task evaluation fixes (57d)', () => {
  const ENTROPIE: SdkTaskRecord = {
    path: 'daily/2026/09/2026-09-18.md',
    vaultId: 'v1',
    line: 7,
    text: 'Entropie-Notiz fertigstellen',
    done: false,
    kind: 'checkbox',
    heading: null,
    tags: [],
    due: null,
    priority: null,
    completed: null,
  };

  function traceOf(args: string, result: string): LlmChatResult['toolTrace'] {
    return [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'tasks_list', arguments: args } }],
      },
      { role: 'tool', tool_call_id: 't1', content: result },
    ];
  }

  it('a short task matches when the answer carries ALL of its words', () => {
    // The live miss: three significant words could never reach SHARED_MIN.
    const answer = 'Als Nächstes solltest du die Entropie-Notiz fertigstellen.';
    expect(matchTasksInAnswer(answer, [ENTROPIE])).toEqual([ENTROPIE]);
    // Two of three words is topic talk, not the task.
    expect(matchTasksInAnswer('Die Entropie-Notiz ist lesenswert.', [ENTROPIE])).toEqual([]);
  });

  it('runTasksListTool maps status / completedSince onto the done view', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const provider = {
      query: async (opts?: Record<string, unknown>) => {
        seen.push({ ...(opts ?? {}) });
        return [ENTROPIE];
      },
      setDone: async () => ENTROPIE,
    };
    await runTasksListTool(provider, '{"status":"done"}');
    expect(seen[0]).toEqual({ includeDone: false, status: 'done', sort: 'completed' });
    // A completion-date restriction implies the done view; a bad date is dropped.
    await runTasksListTool(provider, '{"completedSince":"2026-09-26"}');
    expect(seen[1]).toEqual({
      includeDone: false,
      status: 'done',
      completedSince: '2026-09-26',
      sort: 'completed',
    });
    await runTasksListTool(provider, '{"status":"all","completedSince":"neulich","sort":"due"}');
    expect(seen[2]).toEqual({ includeDone: false, status: 'all', sort: 'due' });
  });

  it('a done-only call is a scoped view the refine never trims', () => {
    expect(taskArgsCarryScopeRestriction('{"status":"done"}')).toBe(true);
    expect(taskArgsCarryScopeRestriction('{"completedSince":"2026-09-26"}')).toBe(true);
    expect(taskArgsCarryScopeRestriction('{"status":"all"}')).toBe(false);
    expect(taskArgsCarryScopeRestriction('{"includeDone":true}')).toBe(false);
  });

  it('the system prompt carries today and puts the task rule after the vault context', async () => {
    const h = chatHarness();
    h.tasksTool = { spec: TASKS_LIST_SPEC, run: async () => '', query: async () => [] };
    await h.engine.ask(ASK);
    const system = String(h.calls[0]?.messages[0]?.content);
    expect(system).toMatch(/Today is \d{4}-\d{2}-\d{2} \(\w+day\)\./);
    expect(system).toContain('"status":"done"');
    expect(system).toContain('ONLY when the user explicitly asks you to modify');
  });

  it('buildDateNote names the local date and weekday', () => {
    expect(buildDateNote(new Date(2026, 9, 10))).toBe('Today is 2026-10-10 (Saturday).');
  });

  it('a fence that changes nothing is an answer, not a proposal', async () => {
    const h = chatHarness(() => ({ text: `Nichts zu tun.\n\n\`\`\`\`document\n${DOC}\`\`\`\`` }));
    const { outcome, chatPath } = await h.engine.ask({ ...ASK, question: 'ja dann mach das' });
    expect(outcome).toEqual({ kind: 'answer', text: 'Nichts zu tun.' });
    expect(parseChatNote(h.files.get(chatPath)!).turns[1].text).toBe('Nichts zu tun.');
  });

  it('a bare no-op fence falls back to a fixed line', async () => {
    const h = chatHarness(() => ({ text: `\`\`\`\`document\n${DOC}\`\`\`\`` }));
    const { outcome } = await h.engine.ask(ASK);
    expect(outcome).toEqual({ kind: 'answer', text: 'No changes were needed.' });
  });

  it('a fence in a task-lookup turn is an answer — the lookup was the request', async () => {
    // The live failure: "ja dann mach das" produced a change proposal for
    // the daily note carrying the looked-up list.
    const h = chatHarness(() => ({
      text: 'Hier sind die erledigten Aufgaben.\n\n````document\n# Titel\n\n- [x] Etwas\n````',
      toolTrace: traceOf('{"status":"done"}', JSON.stringify({ ...ENTROPIE, done: true })),
    }));
    h.tasksTool = { spec: TASKS_LIST_SPEC, run: async () => '', query: async () => [] };
    const { outcome, chatPath } = await h.engine.ask({ ...ASK, question: 'ja dann mach das' });
    expect(outcome).toEqual({ kind: 'answer', text: 'Hier sind die erledigten Aufgaben.' });
    const turn = parseChatNote(h.files.get(chatPath)!).turns[1];
    expect(turn.text).toBe('Hier sind die erledigten Aufgaben.');
    // The done view stays whole: a restricted call is never refined.
    expect(turn.tool.map((e) => e.kind)).toEqual(['call', 'result']);
  });

  it('the post-hoc block falls back to completed tasks for an answer about finished work', async () => {
    const done = { ...ENTROPIE, done: true, completed: '2026-10-09' };
    const h = chatHarness(() => ({ text: 'Zuletzt hast du die Entropie-Notiz fertigstellen können.' }));
    const queries: Array<Record<string, unknown>> = [];
    h.tasksTool = {
      spec: TASKS_LIST_SPEC,
      run: async () => '',
      query: async (opts?: Record<string, unknown>) => {
        queries.push({ ...(opts ?? {}) });
        return opts?.['status'] === 'done' ? [done] : [];
      },
    };
    const { chatPath } = await h.engine.ask({ ...ASK, note: null });
    expect(queries).toEqual([
      { includeDone: false, sort: 'importance' },
      { status: 'done', sort: 'completed' },
    ]);
    const tool = parseChatNote(h.files.get(chatPath)!).turns[1].tool;
    expect(tool[1]?.kind === 'result' && JSON.parse(tool[1].content)).toMatchObject({
      completed: '2026-10-09',
    });
  });
});

describe('assistant plugin chat engine — model-named chats (57e)', () => {
  /** Waits for the fire-and-forget naming call to settle on the note. */
  async function untilTitleLands(h: ReturnType<typeof chatHarness>, chatPath: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (parseChatNote(h.files.get(chatPath)!).frontmatter.title !== 'Worum geht es?') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  it('a brand-new chat asks the model for a title and replaces the placeholder', async () => {
    const h = chatHarness(() => ({ text: 'Antwort.' }), { titleReply: '  "Kaffee am Morgen."\nDanke.' });

    const { chatPath } = await h.engine.ask(ASK);
    await untilTitleLands(h, chatPath);

    const view = parseChatNote(h.files.get(chatPath)!);
    expect(view.frontmatter.title).toBe('Kaffee am Morgen');
    // The naming call: plain — no tools, no vault tools, no stream.
    const titleCall = h.titleCalls[0];
    expect(titleCall?.opts['tools']).toBeUndefined();
    expect(titleCall?.opts['vaultTools']).toBeUndefined();
    expect(titleCall?.messages[1]?.content).toContain('Worum geht es?');
    expect(titleCall?.messages[1]?.content).toContain('Antwort.');
  });

  it('a follow-up ask never renames the chat', async () => {
    const h = chatHarness(() => ({ text: 'Antwort.' }), { titleReply: 'Ersttitel' });
    const first = await h.engine.ask(ASK);
    await untilTitleLands(h, first.chatPath);

    await h.engine.ask({ ...ASK, question: 'Und weiter?', chatPath: first.chatPath });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.titleCalls).toHaveLength(1);
  });

  it('an unusable naming reply keeps the question placeholder', async () => {
    const h = chatHarness(() => ({ text: 'Antwort.' }), { titleReply: '""' });
    const { chatPath } = await h.engine.ask(ASK);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(parseChatNote(h.files.get(chatPath)!).frontmatter.title).toBe('Worum geht es?');
  });

  it('a failing naming call keeps the placeholder and never fails the ask', async () => {
    const h = chatHarness(
      () => ({ text: 'Antwort.' }),
      { titleReply: new Error('model down') },
    );
    const { chatPath, outcome } = await h.engine.ask(ASK);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(outcome.kind).toBe('answer');
    expect(parseChatNote(h.files.get(chatPath)!).frontmatter.title).toBe('Worum geht es?');
  });
});

describe('assistant plugin — title sanitising (57e)', () => {
  it('strips wrapping quotes and a trailing period, keeps the first line only', () => {
    expect(sanitizeChatTitle('  "Kaffee am Morgen. "\nDanke.')).toBe('Kaffee am Morgen');
    expect(sanitizeChatTitle('„Blockuniversum und Zeit«')).toBe('Blockuniversum und Zeit');
  });

  it('caps at 60 chars on a word boundary', () => {
    const long = 'Ein sehr langer Titel der die Sechzig-Zeichen-Grenze deutlich übersteigt und weiter läuft';
    const title = sanitizeChatTitle(long);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(60);
    expect(title!.endsWith(' ')).toBe(false);
  });

  it('null for junk — the placeholder stands', () => {
    expect(sanitizeChatTitle('""')).toBeNull();
    expect(sanitizeChatTitle('x')).toBeNull();
    expect(sanitizeChatTitle(' . ')).toBeNull();
    expect(sanitizeChatTitle('')).toBeNull();
  });

  it('buildTitleUserMessage caps the snippets and skips an empty answer', () => {
    expect(buildTitleUserMessage('Frage', '')).toBe('User: Frage');
    const long = 'x'.repeat(900);
    const built = buildTitleUserMessage(long, long);
    expect(built).not.toContain(long);
    expect(built).toContain('Assistant:');
  });
});

// -- the agentic vault half (ADR-0069) --------------------------------------

const EXPLORE_TOOLS: VaultExploreTools = {
  specs: [
    { name: 'vault_overview', description: 'd', parameters: { type: 'object', properties: {} } },
    { name: 'vault_find', description: 'd', parameters: { type: 'object', properties: {} } },
    { name: 'vault_section', description: 'd', parameters: { type: 'object', properties: {} } },
  ],
  names: new Set(['vault_overview', 'vault_find', 'vault_section']),
  run: async (name) => `ran ${name}`,
};

function systemOf(call: ChatCall): string {
  return String(call.messages[0]?.content ?? '');
}

describe('assistant plugin chat engine — explore tools (ADR-0069)', () => {
  it('a chip-on ask rides the baseline block AND the explore tools, scope, and cap', async () => {
    const h = chatHarness();
    h.retrieval = {
      enabled: true,
      minScore: 0.3,
      hits: [
        {
          vaultId: 'v1',
          vault: 'Notes',
          path: 'a.md',
          heading: 'Near',
          line: 1,
          score: 0.9,
          text: 'NEAR text',
        },
      ],
      targets: ['v1'],
    };
    h.exploreTools = EXPLORE_TOOLS;
    await h.engine.ask({ ...ASK, vaultScope: 'custom', vaultIds: ['v1'] });

    const call = h.calls[0];
    const system = systemOf(call);
    expect(system).toContain('VAULT CONTEXT');
    expect(system).toContain('vault exploration tools');
    const tools = (call.opts['tools'] as ToolSpec[]).map((spec) => spec.name);
    expect(tools).toEqual(['vault_overview', 'vault_find', 'vault_section']);
    expect(call.opts['onToolCall']).toBeInstanceOf(Function);
    expect(call.opts['maxToolRounds']).toBe(6);
    // The scope pass-through is what makes the host drop out-of-scope
    // vault_search/vault_read (SDK 1.20).
    expect(call.opts['vaultToolsScope']).toEqual(['v1']);
    // Routing: an explore name goes to the tools, not "Unknown tool".
    const onToolCall = call.opts['onToolCall'] as (name: string, args: string) => Promise<string>;
    expect(await onToolCall('vault_overview', '{}')).toBe('ran vault_overview');
  });

  it('a chip-off ask carries neither the tools, the note, nor the scope', async () => {
    const h = chatHarness();
    h.exploreTools = EXPLORE_TOOLS;
    await h.engine.ask(ASK);

    const call = h.calls[0];
    expect(systemOf(call)).not.toContain('vault exploration tools');
    expect(call.opts['tools']).toBeUndefined();
    expect(call.opts['vaultToolsScope']).toBeUndefined();
    expect(call.opts['onToolCall']).toBeUndefined();
  });

  it('a provider without tool support keeps the baseline block but no tools', async () => {
    const h = chatHarness();
    h.setCapabilities({ tools: false });
    h.retrieval = {
      enabled: true,
      minScore: 0.3,
      hits: [
        {
          vaultId: 'v1',
          vault: 'Notes',
          path: 'a.md',
          heading: 'Near',
          line: 1,
          score: 0.9,
          text: 'NEAR text',
        },
      ],
      targets: ['v1'],
    };
    h.exploreTools = EXPLORE_TOOLS;
    await h.engine.ask({ ...ASK, vaultScope: 'vault' });

    const call = h.calls[0];
    expect(systemOf(call)).toContain('VAULT CONTEXT');
    expect(systemOf(call)).not.toContain('vault exploration tools');
    expect(call.opts['tools']).toBeUndefined();
    // The scope rides anyway — a harmless no-op for a tools:false provider
    // (there is no tool set left to filter).
    expect(call.opts['vaultToolsScope']).toEqual(['v1']);
  });

  it('a live-edit turn ignores the scope entirely (document + tool loop is context)', async () => {
    const h = chatHarness();
    h.retrieval = { enabled: true, minScore: 0.3, hits: [], targets: ['v1'] };
    h.exploreTools = EXPLORE_TOOLS;
    await h.engine.ask({
      ...ASK,
      note: { path: 'a.md', body: DOC },
      liveEdit: true,
      vaultScope: 'vault',
    });

    const call = h.calls[0];
    expect(call.opts['vaultToolsScope']).toBeUndefined();
    expect(systemOf(call)).not.toContain('vault exploration tools');
  });
});
