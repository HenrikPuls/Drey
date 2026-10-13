import { describe, expect, it } from 'vitest';
import { ChatEngine, type ChatEnginePorts } from './chat-engine';
import { ChatStore, type ChatStorePorts } from './chat-store';
import type { AskRequest } from '../shared/ask';
import type { RetrievalOutcome } from '../shared/semantic';
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

function makeStore(initial?: Record<string, string>): ChatStore {
  const files = new Map<string, string>(Object.entries(initial ?? {}));
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
  llm: { ...DEFAULT_APP_CONFIG.llm, enabled: true, provider: 'test', model: 'm1' },
  tools: {
    ...DEFAULT_APP_CONFIG.tools,
    vault: { write: 'confirm' },
    tasks: { enabled: true },
    templates: { enabled: true, write: 'confirm' },
    webFetch: { enabled: false, approval: 'ask' },
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
}

function makeHarness(overrides?: {
  retrieve?: () => Promise<RetrievalOutcome>;
  vaults?: readonly { id: string; name: string; active: boolean }[];
  chatNote?: Record<string, string>;
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
    onLiveEdit: () => undefined,
    retrieveContext: overrides?.retrieve ?? (async () => ({ enabled: true, minScore: 0.3, hits: [] })),
    onToolEvent: () => undefined,
    semanticEnabled: () => false,
    tasksTool: () => {
      state.tasksCalls += 1;
      return {
        spec: { name: 'tasks_list', description: 'list tasks', parameters: { type: 'object' } },
        run: async () => '',
        query: async () => [],
      };
    },
    templateTools: () => {
      state.templatesCalls += 1;
      return { specs: [], names: new Set(), run: async () => '' };
    },
  };
  const store = makeStore(overrides?.chatNote);
  const engine = new ChatEngine(
    store,
    () => CONFIG,
    async (messages, options) => {
      calls.push({ messages, options: (options ?? {}) as Record<string, unknown> });
      const result: LlmChatResult = { text: 'Answer.' };
      return result;
    },
    () => CAPS,
    ports,
  );
  return {
    engine,
    store,
    calls,
    reads,
    get tasksCalls() {
      return state.tasksCalls;
    },
    get templatesCalls() {
      return state.templatesCalls;
    },
  };
}

describe('ChatEngine scope enforcement (ADR-0069 later change, ADR-0071)', () => {
  it('arms the host scope from the registry even when retrieval is disabled', async () => {
    const h = makeHarness({
      retrieve: async () => ({ enabled: false, minScore: 0.3, hits: [] }),
    });
    await h.engine.ask(askRequest({ vaultScope: 'custom', vaultIds: ['docs'] }));
    // calls[0] is the ask; the fire-and-forget title call may land as a
    // second entry — the assertion only reads the ask's options.
    expect(h.calls[0].options.vaultToolsScope).toEqual(['docs']);
  });

  it('arms the host scope even when retrieval throws — the ask still answers', async () => {
    const h = makeHarness({
      retrieve: async () => {
        throw new Error('embedder down');
      },
    });
    const result = await h.engine.ask(askRequest({ vaultScope: 'custom', vaultIds: ['docs'] }));
    expect(h.calls[0].options.vaultToolsScope).toEqual(['docs']);
    expect(result.outcome.kind).toBe('answer');
  });

  it('withholds the active-vault-only tools when the scope excludes the active vault', async () => {
    const h = makeHarness({
      retrieve: async () => ({ enabled: false, minScore: 0.3, hits: [] }),
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
    expect(h.calls[0].options.vaultTools).toBe(true);
    expect(h.calls[0].options.vaultToolsScope).toEqual(['docs']);
  });

  it('keeps the aux tools when the scope includes the active vault', async () => {
    const h = makeHarness({
      retrieve: async () => ({ enabled: false, minScore: 0.3, hits: [] }),
    });
    await h.engine.ask(askRequest({ vaultScope: 'all' }));
    expect(h.calls[0].options.vaultToolsScope).toEqual(['test', 'docs']);
    expect(h.tasksCalls).toBe(1);
    expect(h.templatesCalls).toBe(1);
    const system = h.calls[0].messages[0]?.content ?? '';
    expect(system).toContain('it defaults to the active vault (`test`)');
    expect(system).toContain('If the question is not about tasks, do not call it');
  });

  it('does not arm a scope and adds no scope notes when the chip is off', async () => {
    const h = makeHarness();
    await h.engine.ask(askRequest({ vaultScope: 'off' }));
    expect(h.calls[0].options.vaultToolsScope).toBeUndefined();
    const system = h.calls[0].messages[0]?.content ?? '';
    expect(system).not.toContain('The vault for this question');
    // Chip off: no way into the vault beyond what is attached (ADR-0071).
    expect(h.calls[0].options.vaultTools).toBeUndefined();
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
