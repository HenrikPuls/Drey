import { describe, expect, it } from 'vitest';
import { ChatEngine, type ChatEnginePorts } from './chat-engine';
import { ChatStore, type ChatStorePorts } from './chat-store';
import type { AskRequest } from '../shared/ask';
import type { RetrievalOutcome } from '../shared/vault-context';
import type { ChatMessage, LlmCapabilities, LlmChatResult } from '../../../shared/llm';
import type { AppConfig } from '../../../shared/app-config';
import { DEFAULT_APP_CONFIG } from '../../../shared/config/defaults';

/**
 * The chat engine's scope enforcement (ADR-0069 later change): the host
 * filter (`vaultToolsScope`) is armed from the REGISTRY-resolved targets —
 * never from the retrieval's outcome — so a disabled or failed retrieval
 * cannot silently re-arm the base tools' active-vault default. And the
 * aux tools that read ONLY the active vault (tasks, templates) are
 * withheld when the chip's scope excludes it (observed trap: a
 * `tasks_list` result answered "what is this vault about").
 */

const VAULTS = [
  { id: 'test', name: 'TestVault', active: true },
  { id: 'docs', name: 'docs', active: false },
] as const;

function makeStore(
  initial?: Record<string, string>,
  files = new Map<string, string>(Object.entries(initial ?? {})),
): ChatStore {
  const ports: ChatStorePorts = {
    read: async (path) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Error(`missing chat note: ${path}`);
      }
      return content;
    },
    writeAnnounced: async (path, content) => {
      files.set(path, content);
    },
    listMarkdownFiles: async () => [...files.keys()],
  };
  return new ChatStore(ports);
}

const CONFIG: AppConfig = {
  ...DEFAULT_APP_CONFIG,
  llm: { ...DEFAULT_APP_CONFIG.llm, enabled: true, provider: 'openai-compat', model: 'm1' },
  tools: {
    ...DEFAULT_APP_CONFIG.tools,
    vault: { write: 'confirm' },
    tasks: { enabled: true },
    templates: { enabled: true, write: 'confirm' },
    webFetch: { enabled: false, approval: 'ask' },
    webSearch: { ...DEFAULT_APP_CONFIG.tools.webSearch },
    servers: [],
  },
};

const CAPS: LlmCapabilities = {
  tools: true,
  streaming: false,
  sessions: false,
  modelListing: false,
  imageAttachments: false,
};

function askRequest(overrides?: Partial<AskRequest>): AskRequest {
  return {
    question: 'worum geht es in dem vault',
    note: null,
    extraFiles: [],
    images: [],
    chatPath: null,
    liveEdit: false,
    noteKey: null,
    vaultScope: 'off',
    vaultIds: [],
    web: false,
    ...overrides,
  };
}

interface Harness {
  engine: ChatEngine;
  store: ChatStore;
  calls: Array<{ messages: readonly ChatMessage[]; options: Record<string, unknown> }>;
  tasksCalls: number;
  templatesCalls: number;
  reads: Array<{ path: string; fallbackVaultIds?: readonly string[] }>;
  /** The chat notes as written, by path. */
  files: Map<string, string>;
}

type NoteChange = { vaultId: string; path: string; before: string; after: string };

function makeHarness(overrides?: {
  retrieve?: () => Promise<RetrievalOutcome>;
  vaults?: readonly { id: string; name: string; active: boolean }[];
  chatNote?: Record<string, string>;
  /** Plays the host: what the model's tool calls do during the one call. */
  reply?: (options: { onVaultChange?: (change: NoteChange) => void }) => LlmChatResult;
  config?: AppConfig;
  caps?: LlmCapabilities;
}): Harness {
  const calls: Harness['calls'] = [];
  const reads: Harness['reads'] = [];
  const state = { tasksCalls: 0, templatesCalls: 0 };
  const ports: ChatEnginePorts = {
    readVaultText: async (path, fallbackVaultIds) => {
      reads.push({ path, fallbackVaultIds });
      return null;
    },
    listVaults: async () => overrides?.vaults ?? VAULTS,
    resolveAssetPath: () => null,
    readAssetBase64: async () => null,
    onDelta: () => undefined,
    retrieveContext: overrides?.retrieve ?? (async () => ({ hits: [] })),
    onToolEvent: () => undefined,
    tasksTool: () => {
      state.tasksCalls += 1;
      return {
        spec: { name: 'tasks_list', description: 'list tasks', parameters: { type: 'object', properties: {} } },
        run: async () => '',
        query: async () => [],
      };
    },
    templateTools: () => {
      state.templatesCalls += 1;
      return { specs: [], names: new Set(), run: async () => '' };
    },
  };
  const files = new Map<string, string>(Object.entries(overrides?.chatNote ?? {}));
  const store = makeStore(undefined, files);
  const engine = new ChatEngine(
    store,
    () => overrides?.config ?? CONFIG,
    async (messages, options) => {
      calls.push({ messages, options: (options ?? {}) as Record<string, unknown> });
      // The title call carries no options and is no part of the exchange.
      if (overrides?.reply !== undefined && options !== undefined) {
        return overrides.reply(options);
      }
      const result: LlmChatResult = { text: 'Answer.' };
      return result;
    },
    () => overrides?.caps ?? CAPS,
    ports,
  );
  return {
    engine,
    store,
    calls,
    reads,
    files,
    get tasksCalls() {
      return state.tasksCalls;
    },
    get templatesCalls() {
      return state.templatesCalls;
    },
  };
}

describe('ChatEngine scope enforcement (ADR-0069 later change, ADR-0071)', () => {
  it('arms the host scope from the registry even when no section index answers', async () => {
    const h = makeHarness({
      retrieve: async () => ({ hits: [], unavailable: true }),
    });
    await h.engine.ask(askRequest({ vaultScope: 'custom', vaultIds: ['docs'] }));
    // calls[0] is the ask; the fire-and-forget title call may land as a
    // second entry — the assertion only reads the ask's options.
    expect(h.calls[0].options['vaultToolsScope']).toEqual(['docs']);
  });

  it('arms the host scope even when retrieval throws — the ask still answers', async () => {
    const h = makeHarness({
      retrieve: async () => {
        throw new Error('index down');
      },
    });
    const result = await h.engine.ask(askRequest({ vaultScope: 'custom', vaultIds: ['docs'] }));
    expect(h.calls[0].options['vaultToolsScope']).toEqual(['docs']);
    expect(result.outcome.kind).toBe('answer');
  });

  it('withholds the active-vault-only tools when the scope excludes the active vault', async () => {
    const h = makeHarness({
      retrieve: async () => ({ hits: [], unavailable: true }),
    });
    await h.engine.ask(askRequest({ vaultScope: 'custom', vaultIds: ['docs'] }));
    expect(h.tasksCalls).toBe(0);
    expect(h.templatesCalls).toBe(0);
    const system = h.calls[0].messages[0]?.content ?? '';
    expect(typeof system).toBe('string');
    // The prompt binds "the vault" to the chip's selection.
    expect(system).toContain('The vault for this question: docs (`docs`)');
    // Tools that are not attached are not mentioned at all (ADR-0071):
    // tasks and templates went with the active vault. The vault tools
    // stay — the host bounds them to the scope.
    expect(system).not.toContain('tasks_list');
    expect(system).not.toContain('template_list');
    expect(system).toContain('- vault_list, vault_search, vault_read');
    expect(h.calls[0].options['vaultTools']).toBe(true);
    expect(h.calls[0].options['vaultToolsScope']).toEqual(['docs']);
  });

  it('keeps the aux tools when the scope includes the active vault', async () => {
    const h = makeHarness({
      retrieve: async () => ({ hits: [], unavailable: true }),
    });
    await h.engine.ask(askRequest({ vaultScope: 'all' }));
    expect(h.calls[0].options['vaultToolsScope']).toEqual(['test', 'docs']);
    expect(h.tasksCalls).toBe(1);
    expect(h.templatesCalls).toBe(1);
    const system = h.calls[0].messages[0]?.content ?? '';
    expect(system).toContain('it defaults to the active vault (`test`)');
    expect(system).toContain('If the question is not about tasks, do not call it');
  });

  it('does not arm a scope and adds no scope notes when the chip is off', async () => {
    const h = makeHarness();
    await h.engine.ask(askRequest({ vaultScope: 'off' }));
    expect(h.calls[0].options['vaultToolsScope']).toBeUndefined();
    const system = h.calls[0].messages[0]?.content ?? '';
    expect(system).not.toContain('The vault for this question');
    // Chip off: no way into the vault beyond what is attached (ADR-0071).
    expect(h.calls[0].options['vaultTools']).toBeUndefined();
    expect(system).not.toContain('vault_search');
  });

  it('hands the replay reader the scoped vaults as attachment fallbacks', async () => {
    const h = makeHarness({
      chatNote: {
        'chats/2026/10/chat.md': [
          '---',
          'kind: chat',
          'created: "2026-10-11T10:00:00"',
          'updated: "2026-10-11T10:00:00"',
          '---',
          '',
          '## User — 2026-10-11T10:00:00',
          '',
          'first question',
          '',
          '[[docs/manual.md]]',
          '',
          '## Assistant — 2026-10-11T10:00:05',
          '',
          'An answer.',
          '',
        ].join('\n'),
      },
    });
    const chatPath = 'chats/2026/10/chat.md';
    await h.engine.ask(
      askRequest({ vaultScope: 'custom', vaultIds: ['docs'], chatPath }),
    );
    expect(h.reads.length).toBeGreaterThan(0);
    expect(h.reads[0].path).toBe('docs/manual.md');
    expect(h.reads[0].fallbackVaultIds).toEqual(['docs']);
  });
});

describe('ChatEngine — a question about a selection (milestone 74)', () => {
  it('sends the selection as its own block and quotes it into the persisted turn', async () => {
    const h = makeHarness();
    const result = await h.engine.ask(
      askRequest({
        question: 'Was heißt das?',
        note: { path: 'a.md', body: 'Erster Satz. Zweiter Satz.' },
        selection: 'Zweiter Satz.',
      }),
    );

    const user = h.calls[0]?.messages.at(-1);
    expect(user?.role).toBe('user');
    expect(user?.content).toContain('INSTRUCTION / QUESTION:\nWas heißt das?');
    expect(user?.content).toContain('SELECTED SECTION');
    expect(user?.content).toContain('Zweiter Satz.\n\nDOCUMENT (a.md):');

    const view = await h.store.read(result.chatPath);
    expect(view.turns[0]?.text).toBe('> Zweiter Satz.\n\nWas heißt das?');
  });

  it('leaves an ordinary ask untouched', async () => {
    const h = makeHarness();
    const result = await h.engine.ask(askRequest({ question: 'Hallo?' }));
    expect(h.calls[0]?.messages.at(-1)?.content).not.toContain('SELECTED SECTION');
    const view = await h.store.read(result.chatPath);
    expect(view.turns[0]?.text).toBe('Hallo?');
  });
});

describe('ChatEngine — the attached note through the vault tools (milestone 78)', () => {
  const NOTE = { path: 'notes/plan.md', body: '# Plan\n\nFee: 10\n', vaultId: 'test' };
  const AFTER = '# Plan\n\nFee: 12\n';
  const systemOf = (h: Harness): string => h.calls[0].messages[0]?.content ?? '';

  it('puts the note into the tools\' scope with the Vault chip off', async () => {
    const h = makeHarness();
    await h.engine.ask(askRequest({ note: NOTE }));

    expect(h.calls[0].options).toMatchObject({
      vaultTools: true,
      vaultToolsScope: [],
      vaultToolsFiles: [{ vaultId: 'test', path: 'notes/plan.md' }],
    });
    expect(systemOf(h)).toContain('call vault_edit with the document\'s path');
    expect(systemOf(h)).not.toContain('````document');
  });

  it('keeps the chip\'s vaults as the scope and adds the note beside them', async () => {
    const h = makeHarness();
    await h.engine.ask(askRequest({ note: NOTE, vaultScope: 'custom', vaultIds: ['docs'] }));

    expect(h.calls[0].options).toMatchObject({
      vaultToolsScope: ['docs'],
      vaultToolsFiles: [{ vaultId: 'test', path: 'notes/plan.md' }],
    });
  });

  it('a change the tools made is the turn\'s applied edit, and the reply is an answer', async () => {
    const h = makeHarness({
      reply: (options) => {
        options.onVaultChange?.({ vaultId: 'test', path: 'notes/other.md', before: 'a', after: 'b' });
        options.onVaultChange?.({ vaultId: 'test', path: NOTE.path, before: NOTE.body, after: AFTER });
        return { text: 'Raised the fee to 12.' };
      },
    });

    const result = await h.engine.ask(askRequest({ note: NOTE }));

    expect(result.outcome).toEqual({ kind: 'answer', text: 'Raised the fee to 12.' });
    const chat = h.files.get(result.chatPath) ?? '';
    expect(chat).toContain('Fee: 12');
    expect(chat).not.toContain('notes/other.md');
  });

  it('a fenced document after a tool change is not offered as a second proposal', async () => {
    const h = makeHarness({
      reply: (options) => {
        options.onVaultChange?.({ vaultId: 'test', path: NOTE.path, before: NOTE.body, after: AFTER });
        return { text: 'Done.\n\n````document\n# Something else\n````' };
      },
    });

    const result = await h.engine.ask(askRequest({ note: NOTE }));

    expect(result.outcome).toEqual({ kind: 'answer', text: 'Done.' });
  });

  it('a live turn marks the note live and reports how many calls changed it', async () => {
    const h = makeHarness({
      reply: (options) => {
        options.onVaultChange?.({ vaultId: 'test', path: NOTE.path, before: NOTE.body, after: 'x\n' });
        options.onVaultChange?.({ vaultId: 'test', path: NOTE.path, before: 'x\n', after: AFTER });
        return { text: '' };
      },
    });

    const result = await h.engine.ask(askRequest({ note: NOTE, liveEdit: true }));

    expect(h.calls[0].options).toMatchObject({
      vaultToolsFiles: [{ vaultId: 'test', path: 'notes/plan.md', live: true }],
    });
    expect(systemOf(h)).toContain('Every change appears in the user\'s editor');
    expect(result.outcome).toEqual({
      kind: 'liveEdit',
      path: 'notes/plan.md',
      applied: 2,
      text: 'Applied 2 edit(s) to notes/plan.md.',
    });
    expect(h.files.get(result.chatPath) ?? '').toContain('Fee: 12');
  });

  it('a chat note and a file from outside the vaults keep the whole-document reply form', async () => {
    for (const note of [
      { path: 'chats/2026/10/talk.md', body: 'x\n', vaultId: 'test' },
      { path: 'C:\\Users\\me\\notes.md', body: 'x\n' },
    ]) {
      const h = makeHarness();
      await h.engine.ask(askRequest({ note }));

      expect(h.calls[0].options['vaultToolsFiles']).toBeUndefined();
      expect(h.calls[0].options['vaultTools']).toBeUndefined();
      expect(systemOf(h)).toContain('````document');
    }
  });

  it('a tab that was never saved is edited with the tools, live too', async () => {
    const h = makeHarness({
      reply: (options) => {
        options.onVaultChange?.({ vaultId: '', path: 'Untitled-1', before: 'x\n', after: 'y\n' });
        return { text: 'Shortened.' };
      },
    });

    const result = await h.engine.ask(
      askRequest({ note: { path: 'Untitled-1', body: 'x\n' }, liveEdit: true }),
    );

    expect(h.calls[0].options).toMatchObject({
      vaultTools: true,
      vaultToolsScope: [],
      vaultToolsFiles: [{ vaultId: null, path: 'Untitled-1', live: true }],
    });
    expect(result.outcome).toMatchObject({ kind: 'liveEdit', applied: 1, text: 'Shortened.' });
  });

  it('a provider without a tool loop keeps the whole-document reply form', async () => {
    const h = makeHarness({ caps: { ...CAPS, tools: false } });
    await h.engine.ask(askRequest({ note: NOTE }));

    expect(h.calls[0].options['vaultToolsFiles']).toBeUndefined();
    expect(systemOf(h)).toContain('````document');
    expect(systemOf(h)).not.toContain('vault_edit');
  });

  it('refuses a live turn on a file from outside the vaults before anything is written', async () => {
    const h = makeHarness();

    await expect(
      h.engine.ask(askRequest({ note: { path: '/home/me/notes.md', body: 'x\n' }, liveEdit: true })),
    ).rejects.toThrow('Live edit is unavailable for this document.');
    expect(h.files.size).toBe(0);
  });
});
