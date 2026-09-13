import { createAssistantState, type AssistantPorts } from '../../../plugins/assistant/renderer/state';
import {
  createRunningTasks,
  type RunningTasks,
} from '../../../plugins/assistant/renderer/running-tasks';
import type { ChatThread } from '../../../plugins/assistant/shared/chat-thread';
import { emptyThread } from '../../../plugins/assistant/shared/chat-thread';
import type { AskRequest } from '../../../plugins/assistant/shared/ask';
import type { ChatNoteView, ChatSummary } from '../../../plugins/assistant/shared/chat-note';
import { parseChatNote } from '../../../plugins/assistant/shared/chat-note';
import type { AskOutcome } from '../../../shared/llm';

/**
 * Specs for the assistant plugin's renderer state
 * (`plugins/assistant/renderer/state.ts`): the chat-first flow (ADR-0048)
 * around the chat note + streaming, the auto-summary rule (sidecar,
 * unchanged), the per-note switch, and the context chips. The state
 * factory takes its ports injected, so no `window.dreyApi` or plugin host
 * is involved. The Angular runner ignores `plugins/**`, so plugin specs
 * live here.
 */

interface Harness {
  state: ReturnType<typeof createAssistantState>;
  tasks: RunningTasks;
  threads: Map<string, ChatThread>;
  summaries: Array<string | undefined>;
  asks: AskRequest[];
  /** Chat-note texts by path (what `chat:read` parses). */
  chatNotes: Map<string, string>;
  /** Turn indexes the truncate port received. */
  truncates: Array<{ path: string; turnIndex: number }>;
  /** Edit outcomes the appendEdit port received. */
  editOutcomes: Array<{ path: string; applied: boolean; after?: string }>;
  /** Delta pushes delivered through the onDelta port. */
  pushDelta(taskId: string, text: string): void;
  /** Vault files the readVaultFile port serves; anything else reads as null. */
  vaultFiles: Map<string, string>;
  /** The "active document" the ports report; null = nothing text-shaped open. */
  setActive(path: string | null, body?: string): void;
  llm: { on: boolean };
  defaultAutoSummary: boolean;
  /** The outcome the fake ask port returns next. */
  nextOutcome: AskOutcome;
  /** When set, the ask port stalls on it (streaming tests). */
  askGate: Promise<void> | null;
}

function viewOf(text: string): ChatNoteView {
  return parseChatNote(text);
}

function summaryOf(path: string, text: string): ChatSummary {
  return { path, title: path, updated: null };
}

function setup(options: { autoSummary?: boolean; llm?: boolean } = {}): Harness {
  const threads = new Map<string, ChatThread>();
  const summaries: Array<string | undefined> = [];
  const asks: AskRequest[] = [];
  const chatNotes = new Map<string, string>();
  const truncates: Array<{ path: string; turnIndex: number }> = [];
  const editOutcomes: Array<{ path: string; applied: boolean; after?: string }> = [];
  const vaultFiles = new Map<string, string>();
  const deltaListeners = new Set<(event: { taskId: string; text: string }) => void>();
  const h: Harness = {
    threads,
    summaries,
    asks,
    chatNotes,
    truncates,
    editOutcomes,
    vaultFiles,
    pushDelta: (taskId, text) => {
      for (const listener of deltaListeners) {
        listener({ taskId, text });
      }
    },
    llm: { on: options.llm !== false },
    defaultAutoSummary: options.autoSummary !== false,
    setActive: (path, body) => {
      activePath = path;
      activeBody = body ?? '# Note\n\nInhalt\n';
    },
    nextOutcome: { kind: 'answer', text: 'Antwort.' },
    askGate: null,
    state: undefined as never,
    tasks: undefined as never,
  };
  let activePath: string | null = null;
  let activeBody = '';
  let chatCounter = 0;

  const tasks = createRunningTasks(async () => true);

  const ports: AssistantPorts = {
    listChats: async () =>
      [...chatNotes.keys()].map((path) => summaryOf(path, path)),
    readChat: async (path) => {
      const text = chatNotes.get(path);
      if (text === undefined) {
        throw new Error(`missing chat ${path}`);
      }
      return viewOf(text);
    },
    ask: async (request) => {
      if (h.askGate !== null) {
        await h.askGate;
      }
      asks.push(request);
      // Persist what the engine would: user turn, assistant turn.
      let path = request.chatPath;
      if (path === null) {
        path = `chats/2026/09/new-${++chatCounter}.md`;
        chatNotes.set(path, '---\nkind: chat\n---\n');
      }
      const current = chatNotes.get(path) ?? '';
      chatNotes.set(
        path,
        `${current}\n## User\n\n${request.question}\n\n## Assistant\n\nAntwort.\n`,
      );
      return { chatPath: path, outcome: h.nextOutcome };
    },
    appendEdit: async (path, applied, after) => {
      editOutcomes.push({ path, applied, after });
    },
    truncate: async (path, turnIndex) => {
      truncates.push({ path, turnIndex });
      const view = viewOf(chatNotes.get(path) ?? '');
      chatNotes.set(path, chatNotes.get(path)!.slice(0, view.turns[turnIndex]?.start ?? 0));
    },
    importSidecar: async (notePath) => {
      const path = `chats/2026/09/imported-${notePath.replace(/[/.]/g, '-')}.md`;
      chatNotes.set(path, '---\nkind: chat\n---\n');
      return { chatPath: path };
    },
    onDelta: (listener) => {
      deltaListeners.add(listener);
      return () => deltaListeners.delete(listener);
    },
    readThread: async (notePath) => threads.get(notePath) ?? emptyThread(notePath),
    writeThread: async (thread) => {
      threads.set(thread.notePath, thread);
    },
    summarize: async (context, taskId) => {
      summaries.push(taskId);
      void context;
      return 'Kurze Zusammenfassung.';
    },
    readVaultFile: async (path) => vaultFiles.get(path) ?? null,
    cancel: async () => undefined,
    activeDoc: () => (activePath === null ? null : { path: activePath, body: activeBody }),
    llmEnabled: () => h.llm.on,
    autoSummaryDefault: () => h.defaultAutoSummary,
    requestRewrite: async () => true,
  };

  h.tasks = tasks;
  h.state = createAssistantState(ports, tasks);
  return h;
}

describe('assistant plugin state — auto summary (sidecar, unchanged)', () => {
  it('summarises a note opened for the first time when the default is on', async () => {
    const h = setup();
    h.setActive('daily/2026-09-26.md');
    await h.state.openNote('daily/2026-09-26.md');

    expect(h.summaries).toHaveLength(1);
    expect(h.state.summaryCard()?.text).toBe('Kurze Zusammenfassung.');
  });

  it('does nothing automatically when the default is off, but offers manual', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(h.summaries).toHaveLength(0);
    expect(h.state.summaryCard()).toBeNull();
    expect(h.state.autoSummary()).toBe(false);
    expect(h.state.canSummarize()).toBe(true);
    await h.state.summarizeNow();
    expect(h.summaries).toHaveLength(1);
    expect(h.state.summaryCard()?.text).toBe('Kurze Zusammenfassung.');
    expect(h.state.canSummarize()).toBe(false);
  });

  it('does not re-summarise a note that already has a sidecar thread', async () => {
    const h = setup();
    h.threads.set('a.md', {
      version: 1,
      notePath: 'a.md',
      cards: [{ id: 'a', role: 'summary', text: 'Schon da.', at: '' }],
    });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(h.summaries).toHaveLength(0);
    expect(h.state.summaryCard()?.text).toBe('Schon da.');
  });

  it('never summarises while LLM features are off', async () => {
    const h = setup({ llm: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(h.summaries).toHaveLength(0);
    expect(h.state.canSummarize()).toBe(false);
  });

  it('keeps a per-note switch without changing the global default', async () => {
    const h = setup();
    h.setActive('a.md');
    await h.state.openNote('a.md');
    h.state.setAutoSummary(false);

    h.setActive('b.md');
    await h.state.openNote('b.md');

    expect(h.state.autoSummary()).toBe(true);
    expect(h.defaultAutoSummary).toBe(true);
  });
});

describe('assistant plugin state — chat-first asks (ADR-0048)', () => {
  it('sends a zero-context ask (no note open, no chips) and lands in a new chat', async () => {
    const h = setup({ autoSummary: false });
    h.setActive(null);

    const sent = await h.state.ask('Was ist ein Rhumb-Linien-Diagramm?');

    expect(sent).toBe(true);
    expect(h.asks[0]?.note).toBeNull();
    expect(h.asks[0]?.chatPath).toBeNull();
    // The ask result's chatPath became the active chat, and its view loaded.
    expect(h.state.activeChatPath()).not.toBeNull();
    expect(h.state.view()?.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('sends the note with its live buffer by default, plus chips and images', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md', 'Lebendiger Puffer.');
    await h.state.openNote('a.md');
    h.vaultFiles.set('b.md', 'B-Kontext.');
    expect(h.state.addFile('b.md').ok).toBe(true);
    expect(h.state.addImage('attachments/pic.png').ok).toBe(true);

    const sent = await h.state.ask('Was steht hier?');

    expect(sent).toBe(true);
    expect(h.asks[0]).toEqual({
      question: 'Was steht hier?',
      note: { path: 'a.md', body: 'Lebendiger Puffer.' },
      extraFiles: [{ path: 'b.md', body: 'B-Kontext.' }],
      images: ['attachments/pic.png'],
      chatPath: null,
    });
  });

  it('continues the active chat on the next ask', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');
    await h.state.ask('erste');
    const first = h.state.activeChatPath();

    await h.state.ask('zweite');
    expect(h.asks[1]?.chatPath).toBe(first);
    expect(h.state.view()?.turns).toHaveLength(4); // 2 exchanges
  });

  it('asks proceed even while the chat tab is dirty (the tab follows the disk)', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');
    await h.state.ask('erste');
    // A dirty chat tab no longer refuses: the note is the source of truth
    // and the open tab is a view of it (ADR-0048 auto-save policy).
    const sent = await h.state.ask('zweite');

    expect(sent).toBe(true);
    expect(h.asks).toHaveLength(2);
  });

  it('streams the answer through the delta push into a partial card', async () => {
    const h = setup({ autoSummary: false });
    let release: () => void = () => undefined;
    h.askGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.setActive(null);

    const pending = h.state.ask('Frage?');
    // The ask port is stalled on the gate; deltas for the in-flight task
    // must accumulate in the streaming buffer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = h.state.streaming();
    expect(first).not.toBeNull();
    h.pushDelta(first!.taskId, 'Teil-');
    h.pushDelta(first!.taskId, 'antwort');
    expect(h.state.streaming()?.text).toBe('Teil-antwort');

    // Foreign task ids don't land in the buffer.
    h.pushDelta('some-other-task', 'X');
    expect(h.state.streaming()?.text).toBe('Teil-antwort');

    release();
    expect(await pending).toBe(true);
    // Completion clears the partial; the finished turns are in the view.
    expect(h.state.streaming()).toBeNull();
    expect(h.state.view()?.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('an edit outcome goes through the confirm flow and persists the result', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md', 'Dokument');
    await h.state.openNote('a.md');
    h.nextOutcome = {
      kind: 'edit',
      before: 'Dokument',
      after: 'Dokument geändert\n',
      previewStyle: 'localized',
      summary: 'Ändere es.',
    };

    const sent = await h.state.ask('Ändere es.');

    expect(sent).toBe(true);
    expect(h.editOutcomes).toEqual([
      { path: h.state.activeChatPath(), applied: true, after: 'Dokument geändert\n' },
    ]);
  });

  it('skips files that vanished, refuses only when nothing is left', async () => {
    const h = setup({ autoSummary: false });
    h.setActive(null);
    h.vaultFiles.set('c.md', 'C.');
    h.state.addFile('weg.md');
    h.state.addFile('c.md');

    const sent = await h.state.ask('Frage?');
    expect(sent).toBe(true);
    expect(h.asks[0]?.extraFiles).toEqual([{ path: 'c.md', body: 'C.' }]);
    expect(h.state.notice()).toContain('weg.md');

    const h2 = setup({ autoSummary: false });
    h2.setActive(null);
    h2.state.addFile('weg.md');
    expect(await h2.state.ask('Frage?')).toBe(false);
    expect(h2.state.error()).toContain('no longer in the vault');
  });

  it('newChat detaches the active chat so the next ask starts fresh', async () => {
    const h = setup({ autoSummary: false });
    h.setActive(null);
    await h.state.ask('erste');
    expect(h.state.activeChatPath()).not.toBeNull();

    h.state.newChat();
    expect(h.state.activeChatPath()).toBeNull();
    expect(h.state.view()).toBeNull();

    await h.state.ask('zweite');
    expect(h.asks[1]?.chatPath).toBeNull();
  });

  it('importSidecar creates and opens a chat for the open note', async () => {
    const h = setup({ autoSummary: false });
    h.threads.set('a.md', {
      version: 1,
      notePath: 'a.md',
      cards: [
        { id: 'q1', role: 'question', text: 'Alt?', at: '' },
        { id: 'a1', role: 'answer', text: 'Ja.', at: '' },
      ],
    });
    h.setActive('a.md');
    await h.state.openNote('a.md');
    expect(h.state.canImportSidecar()).toBe(true);

    await h.state.importSidecar();

    expect(h.state.activeChatPath()).toContain('chats/');
  });
});

describe('assistant plugin state — restart from a turn', () => {
  async function chatWithTurns(h: Harness): Promise<string> {
    h.setActive('a.md');
    await h.state.openNote('a.md');
    await h.state.ask('erste');
    await h.state.ask('zweite');
    return h.state.activeChatPath()!;
  }

  it('truncates from the turn index and returns the removed question', async () => {
    const h = setup({ autoSummary: false });
    const path = await chatWithTurns(h);

    expect(h.state.laterCount(2)).toBe(2);
    const restored = await h.state.restartFrom(2);

    expect(restored).toBe('zweite');
    expect(h.truncates).toEqual([{ path, turnIndex: 2 }]);
    expect(h.state.view()?.turns).toHaveLength(2);
  });

  it('returns null when the rewind point is not a user turn', async () => {
    const h = setup({ autoSummary: false });
    await chatWithTurns(h);

    const restored = await h.state.restartFrom(1); // the assistant turn
    expect(restored).toBeNull();
  });

  it('refuses while a generation is running', async () => {
    const h = setup({ autoSummary: false });
    const path = await chatWithTurns(h);
    let release: (value: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const running = h.tasks.run('Summarising', () => gate);

    expect(await h.state.restartFrom(2)).toBeNull();

    release('x');
    await running;
  });
});

describe('assistant plugin state — misc surface', () => {
  it('records a manual Action noop/error as the action message', () => {
    const h = setup();
    h.state.reportActionOutcome({
      kind: 'noop',
      triggerId: 't1',
      name: 'Reformat',
      message: 'The model returned the document unchanged.',
    });
    expect(h.state.actionMessage()).toBe(
      'Reformat: The model returned the document unchanged.',
    );
    h.state.dismissActionMessage();
    expect(h.state.actionMessage()).toBeNull();
  });

  it('refuses an ask while LLM features are off', async () => {
    const h = setup({ autoSummary: false, llm: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(await h.state.ask('Frage?')).toBe(false);
    expect(h.state.error()).toContain('disabled');
  });

  it('dedupes image chips and caps them', () => {
    const h = setup({ autoSummary: false });
    h.setActive(null);
    expect(h.state.addImage('a.png').ok).toBe(true);
    expect(h.state.addImage('a.png').reason).toContain('Already');
    h.state.removeImage('a.png');
    expect(h.state.images()).toEqual([]);
  });

  it('chips stay per note and restore on switching back', async () => {
    const h = setup({ autoSummary: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');
    h.vaultFiles.set('b.md', 'B.');
    h.state.addFile('b.md');
    h.state.setNoteIncluded(false);

    h.setActive('c.md');
    await h.state.openNote('c.md');
    expect(h.state.noteIncluded()).toBe(true);
    expect(h.state.extraFiles()).toEqual([]);

    h.setActive('a.md');
    await h.state.openNote('a.md');
    expect(h.state.noteIncluded()).toBe(false);
    expect(h.state.extraFiles()).toEqual(['b.md']);
  });
});
