import { createAssistantState, type AssistantPorts } from '../../../plugins/assistant/renderer/state';
import {
  createRunningTasks,
  type RunningTasks,
} from '../../../plugins/assistant/renderer/running-tasks';
import type { AskRequest, AssistantOutcome } from '../../../plugins/assistant/shared/ask';
import type { ChatNoteView, ChatSummary } from '../../../plugins/assistant/shared/chat-note';
import { parseChatNote } from '../../../plugins/assistant/shared/chat-note';

/**
 * Specs for the assistant plugin's renderer state
 * (`plugins/assistant/renderer/state.ts`): the chat-first flow (ADR-0048)
 * around the chat note + streaming and the context chips. The state
 * factory takes its ports injected, so no `window.dreyApi` or plugin host
 * is involved. The Angular runner ignores `plugins/**`, so plugin specs
 * live here.
 */

interface Harness {
  state: ReturnType<typeof createAssistantState>;
  tasks: RunningTasks;
  asks: AskRequest[];
  /** Chat-note texts by path (what `chat:read` parses). */
  chatNotes: Map<string, string>;
  /** Turn indexes the truncate port received. */
  truncates: Array<{ path: string; turnIndex: number }>;
  /** Edit outcomes the appendEdit port received. */
  editOutcomes: Array<{ path: string; applied: boolean; after?: string }>;
  /** Rewrite requests the requestRewrite port received (the confirm dialog). */
  rewrites: Array<{ path: string; title: string }>;
  /** Edit-lock operations the setEditLock port received, in order. */
  lockOps: Array<{ path: string; locked: boolean }>;
  /** Delta pushes delivered through the onDelta port. */
  pushDelta(taskId: string, text: string): void;
  /** Vault files the readVaultFile port serves; anything else reads as null. */
  vaultFiles: Map<string, string>;
  /** Open scratch tabs the scratchBody port serves (docPath -> buffer). */
  scratchDocs: Map<string, string>;
  /** Snapshots the writeScratchSnapshot port wrote (also seeded into vaultFiles). */
  snapshots: Array<{ path: string; body: string }>;
  /** When set, writeScratchSnapshot rejects (disk failure). */
  failSnapshot: boolean;
  /** The "active document" the ports report; null = nothing text-shaped open. */
  setActive(path: string | null, body?: string, vaultId?: string | null): void;
  /** The vaultId the active document port reports (null = unbound scratch). */
  setActiveVaultId(vaultId: string | null): void;
  llm: { on: boolean };
  /** The outcome the fake ask port returns next. */
  nextOutcome: AssistantOutcome;
  /** When set, the ask port stalls on it (streaming tests). */
  askGate: Promise<void> | null;
}

function viewOf(text: string): ChatNoteView {
  return parseChatNote(text);
}

function summaryOf(path: string, text: string): ChatSummary {
  // Mirrors ChatStore.listChats: parse each note, surface `note:`, sort
  // by `updated:` descending (newest first).
  const view = viewOf(text);
  return { path, title: view.frontmatter.title ?? path, updated: view.frontmatter.updated, note: view.frontmatter.note };
}

function setup(options: { llm?: boolean } = {}): Harness {
  const asks: AskRequest[] = [];
  const chatNotes = new Map<string, string>();
  const truncates: Array<{ path: string; turnIndex: number }> = [];
  const editOutcomes: Array<{ path: string; applied: boolean; after?: string }> = [];
  const rewrites: Array<{ path: string; title: string }> = [];
  const lockOps: Array<{ path: string; locked: boolean }> = [];
  const vaultFiles = new Map<string, string>();
  const scratchDocs = new Map<string, string>();
  const snapshots: Array<{ path: string; body: string }> = [];
  const deltaListeners = new Set<(event: { taskId: string; text: string }) => void>();
  const h: Harness = {
    asks,
    chatNotes,
    truncates,
    editOutcomes,
    rewrites,
    lockOps,
    vaultFiles,
    scratchDocs,
    snapshots,
    failSnapshot: false,
    pushDelta: (taskId, text) => {
      for (const listener of deltaListeners) {
        listener({ taskId, text });
      }
    },
    llm: { on: options.llm !== false },
    setActive: (path, body) => {
      activePath = path;
      activeBody = body ?? '# Note\n\nInhalt\n';
    },
    setActiveVaultId: (vaultId) => {
      activeVaultId = vaultId;
    },
    nextOutcome: { kind: 'answer', text: 'Antwort.' },
    askGate: null,
    state: undefined as never,
    tasks: undefined as never,
  };
  let activePath: string | null = null;
  let activeBody = '';
  let activeVaultId: string | null = 'v1';
  let chatCounter = 0;

  const tasks = createRunningTasks(async () => true);

  const ports: AssistantPorts = {
    listChats: async () =>
      [...chatNotes.entries()]
        .map(([path, text]) => summaryOf(path, text))
        .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')),
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
      return { chatPath: path, outcome: h.nextOutcome, contextCount: 0 };
    },
    appendEdit: async (path, applied, after) => {
      editOutcomes.push({ path, applied, after });
    },
    truncate: async (path, turnIndex) => {
      truncates.push({ path, turnIndex });
      const view = viewOf(chatNotes.get(path) ?? '');
      chatNotes.set(path, chatNotes.get(path)!.slice(0, view.turns[turnIndex]?.start ?? 0));
    },
    attachExternal: async () => ({ staged: [], skipped: [] }),
    onDelta: (listener) => {
      deltaListeners.add(listener);
      return () => deltaListeners.delete(listener);
    },
    readVaultFile: async (path) => vaultFiles.get(path) ?? null,
    scratchBody: (docPath) => scratchDocs.get(docPath) ?? null,
    writeScratchSnapshot: async (docPath, body) => {
      if (h.failSnapshot) {
        throw new Error('disk full');
      }
      const path = `.drafts/assistant/snap-${docPath}`;
      snapshots.push({ path, body });
      vaultFiles.set(path, body);
      return path;
    },
    cancel: async () => undefined,
    activeDoc: () =>
      activePath === null ? null : { path: activePath, body: activeBody, vaultId: activeVaultId },
    llmEnabled: () => h.llm.on,
    requestRewrite: async (request) => {
      rewrites.push({ path: request.path, title: request.title });
      return true;
    },
    setEditLock: (path, locked) => {
      lockOps.push({ path, locked });
    },
  };

  h.tasks = tasks;
  h.state = createAssistantState(ports, tasks);
  return h;
}

describe('assistant plugin state — chat-first asks (ADR-0048)', () => {
  it('sends a zero-context ask (no note open, no chips) and lands in a new chat', async () => {
    const h = setup();
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
    const h = setup();
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
      liveEdit: false,
      noteKey: 'v1::a.md',
      vaultScope: 'off',
    });
  });

  it('continues the active chat on the next ask', async () => {
    const h = setup();
    h.setActive('a.md');
    await h.state.openNote('a.md');
    await h.state.ask('erste');
    const first = h.state.activeChatPath();

    await h.state.ask('zweite');
    expect(h.asks[1]?.chatPath).toBe(first);
    expect(h.state.view()?.turns).toHaveLength(4); // 2 exchanges
  });

  it('asks proceed even while the chat tab is dirty (the tab follows the disk)', async () => {
    const h = setup();
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
    const h = setup();
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
    const h = setup();
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
    const h = setup();
    h.setActive(null);
    h.vaultFiles.set('c.md', 'C.');
    h.state.addFile('weg.md');
    h.state.addFile('c.md');

    const sent = await h.state.ask('Frage?');
    expect(sent).toBe(true);
    expect(h.asks[0]?.extraFiles).toEqual([{ path: 'c.md', body: 'C.' }]);
    expect(h.state.notice()).toContain('weg.md');

    const h2 = setup();
    h2.setActive(null);
    h2.state.addFile('weg.md');
    expect(await h2.state.ask('Frage?')).toBe(false);
    expect(h2.state.error()).toContain('no longer in the vault');
  });

  it('newChat detaches the active chat so the next ask starts fresh', async () => {
    const h = setup();
    h.setActive(null);
    await h.state.ask('erste');
    expect(h.state.activeChatPath()).not.toBeNull();

    h.state.newChat();
    expect(h.state.activeChatPath()).toBeNull();
    expect(h.state.view()).toBeNull();

    await h.state.ask('zweite');
    expect(h.asks[1]?.chatPath).toBeNull();
  });
});

describe('assistant plugin state — scratch-tab chips (search summary as context)', () => {
  it('attaches an unsaved tab as its live buffer and snapshots it at send', async () => {
    const h = setup();
    h.setActive(null);
    h.scratchDocs.set('search-summary.md', '# Summary\n\nTreffer …');
    expect(h.state.addScratch('search-summary.md').ok).toBe(true);

    const sent = await h.state.ask('Fasse zusammen.');

    expect(sent).toBe(true);
    expect(h.snapshots).toEqual([
      { path: '.drafts/assistant/snap-search-summary.md', body: '# Summary\n\nTreffer …' },
    ]);
    expect(h.asks[0]?.extraFiles).toEqual([
      { path: '.drafts/assistant/snap-search-summary.md', body: '# Summary\n\nTreffer …' },
    ]);
  });

  it('reuses the last snapshot when the tab is closed by the next send', async () => {
    const h = setup();
    h.setActive(null);
    h.scratchDocs.set('search-summary.md', 'Erster Stand.');
    expect(h.state.addScratch('search-summary.md').ok).toBe(true);
    await h.state.ask('erste');
    expect(h.snapshots).toHaveLength(1);

    // Tab closed; only the snapshot remains (later turns re-read it fresh,
    // same rule as the other vault attachments).
    h.scratchDocs.delete('search-summary.md');
    const sent = await h.state.ask('zweite');

    expect(sent).toBe(true);
    expect(h.snapshots).toHaveLength(1); // no new snapshot without the tab
    expect(h.asks[1]?.extraFiles).toEqual([
      { path: '.drafts/assistant/snap-search-summary.md', body: 'Erster Stand.' },
    ]);
  });

  it('skips a scratch tab that is closed and was never sent, keeping other context', async () => {
    const h = setup();
    h.setActive(null);
    h.scratchDocs.set('search-summary.md', 'Text');
    expect(h.state.addScratch('search-summary.md').ok).toBe(true);
    h.vaultFiles.set('b.md', 'B.');
    expect(h.state.addFile('b.md').ok).toBe(true);
    h.scratchDocs.delete('search-summary.md');

    const sent = await h.state.ask('Frage?');

    expect(sent).toBe(true);
    expect(h.asks[0]?.extraFiles).toEqual([{ path: 'b.md', body: 'B.' }]);
    expect(h.state.notice()).toContain('tab not open');

    // With nothing else attached, the missing tab is a hard error instead
    // of a silently context-less question.
    const h2 = setup();
    h2.setActive(null);
    h2.scratchDocs.set('search-summary.md', 'Text');
    h2.state.addScratch('search-summary.md');
    h2.scratchDocs.delete('search-summary.md');
    expect(await h2.state.ask('Frage?')).toBe(false);
    expect(h2.state.error()).toContain('no longer in the vault');
  });

  it('dedupes scratch chips and folds a focused tab into the note chip', async () => {
    const h = setup();
    h.setActive(null);
    h.scratchDocs.set('search-summary.md', 'Text');
    expect(h.state.addScratch('search-summary.md').ok).toBe(true);
    expect(h.state.addScratch('search-summary.md').reason).toBe('Already attached.');

    // Focusing the tab makes it the note chip: attaching is refused while
    // the chip is on, and re-includes the note when it was excluded.
    await h.state.openNote('search-summary.md');
    expect(h.state.addScratch('search-summary.md').reason).toBe(
      'This document is already attached.',
    );
    h.state.setNoteIncluded(false);
    expect(h.state.addScratch('search-summary.md').ok).toBe(true);
    expect(h.state.noteIncluded()).toBe(true);
  });
});

describe('assistant plugin state — following the active document (chat binding)', () => {
  /** A chat note bound to `v1::a.md`, oldest first. */
  function boundChat(name: string, updated: string, note: string | null): [string, string] {
    const noteLine = note === null ? '' : `\nnote: "${note}"`;
    return [
      `chats/2026/09/${name}.md`,
      `---\nkind: chat\ntitle: ${name}${noteLine}\ncreated: 2026-09-13\nupdated: ${updated}\n---\n`,
    ];
  }

  it('opens the newest chat bound to the active document', async () => {
    const h = setup();
    h.chatNotes.set(...boundChat('old', '2026-09-13T10:00:00', 'v1::a.md'));
    h.chatNotes.set(...boundChat('new', '2026-09-13T12:00:00', 'v1::a.md'));
    h.chatNotes.set(...boundChat('other', '2026-09-13T13:00:00', 'v1::b.md'));

    await h.state.followActiveDoc('v1::a.md');

    expect(h.state.activeChatPath()).toBe('chats/2026/09/new.md');
  });

  it('resets to a fresh chat when no chat is bound to the document', async () => {
    const h = setup();
    h.chatNotes.set(...boundChat('other', '2026-09-13T13:00:00', 'v1::b.md'));
    await h.state.followActiveDoc('v1::a.md'); // binds nothing
    expect(h.state.activeChatPath()).toBeNull();

    // A previously open chat does not survive the switch to an unbound doc.
    h.chatNotes.set(...boundChat('mine', '2026-09-13T09:00:00', null));
    await h.state.openChat('chats/2026/09/mine.md');
    expect(h.state.activeChatPath()).toBe('chats/2026/09/mine.md');

    await h.state.followActiveDoc('v1::a.md');
    expect(h.state.activeChatPath()).toBeNull();
  });

  it('a bound chat already open stays put (no reload churn on docs-changed)', async () => {
    const h = setup();
    h.chatNotes.set(...boundChat('mine', '2026-09-13T10:00:00', 'v1::a.md'));
    await h.state.followActiveDoc('v1::a.md');
    const before = h.state.activeChatPath();

    await h.state.followActiveDoc('v1::a.md');
    expect(h.state.activeChatPath()).toBe(before);
  });

  it('is skipped while a generation runs', async () => {
    const h = setup();
    h.chatNotes.set(...boundChat('mine', '2026-09-13T10:00:00', 'v1::a.md'));
    h.setActive('a.md');
    h.askGate = new Promise(() => undefined); // the ask never resolves
    void h.state.ask('wartet');
    expect(h.state.asking()).toBe(true);

    await h.state.followActiveDoc(null);

    // Not reset to fresh: the running generation's chat stays active.
    expect(h.state.activeChatPath()).toBeNull(); // still the pre-ask fresh state
  });

  it('a superseded follow never lands (rapid A → B switches)', async () => {
    const h = setup();
    h.chatNotes.set(...boundChat('a-chat', '2026-09-13T10:00:00', 'v1::a.md'));

    const first = h.state.followActiveDoc('v1::a.md');
    const second = h.state.followActiveDoc('v1::b.md');
    await Promise.all([first, second]);

    // The b-follow decided "fresh"; the slower a-follow must not reopen.
    expect(h.state.activeChatPath()).toBeNull();
  });
});

describe('assistant plugin state — live edit (ADR-0049)', () => {
  it('refuses to toggle without an open note, and on auto-save paths', async () => {
    const h = setup();
    h.setActive(null);
    h.state.toggleLiveEdit();
    expect(h.state.liveEdit()).toBe(false);
    expect(h.state.notice()).toContain('Open a note');

    const h2 = setup();
    h2.setActive('chats/2026/09/chat.md', '---\nkind: chat\n---\n');
    await h2.state.openNote('chats/2026/09/chat.md');
    h2.state.toggleLiveEdit();
    expect(h2.state.liveEdit()).toBe(false);
    expect(h2.state.notice()).toContain('not available');
  });

  it('turning the chip on re-includes the note; excluding the note turns it off', async () => {
    const h = setup();
    h.setActive('a.md');
    await h.state.openNote('a.md');
    h.state.setNoteIncluded(false);
    h.state.toggleLiveEdit();
    expect(h.state.liveEdit()).toBe(true);
    expect(h.state.noteIncluded()).toBe(true);

    h.state.setNoteIncluded(false);
    expect(h.state.liveEdit()).toBe(false);
  });

  it('a live ask locks the note, sends liveEdit, and reports instead of confirming', async () => {
    const h = setup();
    h.setActive('a.md', '# Alt\n');
    await h.state.openNote('a.md');
    h.state.toggleLiveEdit();
    h.nextOutcome = { kind: 'liveEdit', path: 'a.md', applied: 2, text: 'Zwei Hunks angewandt.' };

    const sent = await h.state.ask('Mach es neu.');

    expect(sent).toBe(true);
    expect(h.asks[0]?.liveEdit).toBe(true);
    expect(h.asks[0]?.note).toEqual({ path: 'a.md', body: '# Alt\n' });
    expect(h.lockOps).toEqual([
      { path: 'a.md', locked: true },
      { path: 'a.md', locked: false },
    ]);
    expect(h.rewrites).toEqual([]);
    expect(h.editOutcomes).toEqual([]);
    expect(h.state.notice()).toBe('Applied 2 edit(s) to a.md.');
  });

  it('reports a no-change live turn, and releases the lock when the ask fails', async () => {
    const h = setup();
    h.setActive('a.md');
    await h.state.openNote('a.md');
    h.state.toggleLiveEdit();
    h.nextOutcome = { kind: 'liveEdit', path: 'a.md', applied: 0, text: 'Nichts zu tun.' };
    await h.state.ask('Nur so.');
    expect(h.state.notice()).toBe('No changes were needed.');
    expect(h.lockOps).toEqual([
      { path: 'a.md', locked: true },
      { path: 'a.md', locked: false },
    ]);

    const h2 = setup();
    h2.setActive('a.md');
    await h2.state.openNote('a.md');
    h2.state.toggleLiveEdit();
    h2.askGate = Promise.reject(new Error('boom'));

    const sent = await h2.state.ask('Kaputt.');

    expect(sent).toBe(false);
    expect(h2.state.error()).toContain('boom');
    expect(h2.lockOps).toEqual([
      { path: 'a.md', locked: true },
      { path: 'a.md', locked: false },
    ]);
  });

  it('clamps the flag when the active document is not live-editable', async () => {
    const h = setup();
    h.setActive('a.md');
    await h.state.openNote('a.md');
    h.state.toggleLiveEdit();
    // The tab switched to a chat note after the toggle — the note chip
    // would attach it; the payload must not carry liveEdit.
    h.setActive('chats/2026/09/chat.md', '---\nkind: chat\n---\n');

    await h.state.ask('Was steht da?');

    expect(h.asks[0]?.liveEdit).toBe(false);
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
    const h = setup();
    const path = await chatWithTurns(h);

    expect(h.state.laterCount(2)).toBe(2);
    const restored = await h.state.restartFrom(2);

    expect(restored).toBe('zweite');
    expect(h.truncates).toEqual([{ path, turnIndex: 2 }]);
    expect(h.state.view()?.turns).toHaveLength(2);
  });

  it('returns null when the rewind point is not a user turn', async () => {
    const h = setup();
    await chatWithTurns(h);

    const restored = await h.state.restartFrom(1); // the assistant turn
    expect(restored).toBeNull();
  });

  it('refuses while a generation is running', async () => {
    const h = setup();
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
    const h = setup({ llm: false });
    h.setActive('a.md');
    await h.state.openNote('a.md');

    expect(await h.state.ask('Frage?')).toBe(false);
    expect(h.state.error()).toContain('disabled');
  });

  it('dedupes image chips and caps them', () => {
    const h = setup();
    h.setActive(null);
    expect(h.state.addImage('a.png').ok).toBe(true);
    expect(h.state.addImage('a.png').reason).toContain('Already');
    h.state.removeImage('a.png');
    expect(h.state.images()).toEqual([]);
  });

  it('chips stay per note and restore on switching back', async () => {
    const h = setup();
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

describe('assistant plugin state — document-follow catch-up', () => {
  it('re-follows a doc switch that happened while a generation was running', async () => {
    const h = setup();
    let release: () => void = () => undefined;
    h.setActive('a.md');
    await h.state.openNote('a.md');
    await h.state.ask('erste');
    const aChat = h.state.activeChatPath();
    expect(aChat).not.toBeNull();

    // A second generation starts; mid-flight the user switches to b.md,
    // which already has its own bound chat.
    h.askGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = h.state.ask('zweite');
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.chatNotes.set(
      'chats/2026/09/b-chat.md',
      "---\nkind: chat\nnote: 'v1::b.md'\ntitle: b chat\n---\n",
    );
    h.setActive('b.md');
    await h.state.followActiveDoc('v1::b.md'); // deferred while asking
    expect(h.state.activeChatPath()).toBe(aChat); // the run keeps its chat

    release();
    expect(await pending).toBe(true);
    // The ask's finally releases `asking` and runs the deferred follow.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.state.activeChatPath()).toBe('chats/2026/09/b-chat.md');
  });
});
