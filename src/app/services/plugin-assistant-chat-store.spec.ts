import { ChatStore } from '../../../plugins/assistant/main/chat-store';
import { parseChatNote } from '../../../plugins/assistant/shared/chat-note';

/** Minimal in-memory vault: what ChatStore's ports need. */
function fakeVault(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const written: string[] = [];
  return {
    files,
    written,
    ports: {
      read: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) {
          throw new Error(`missing: ${path}`);
        }
        return content;
      },
      writeAnnounced: async (path: string, content: string) => {
        files.set(path, content);
        written.push(path);
        return 0;
      },
      listMarkdownFiles: async () =>
        [...files.keys()].filter((p) => p.toLowerCase().endsWith('.md')),
    },
  };
}

const NOW = new Date(2026, 8, 13, 14, 32, 0);

describe('ChatStore — create', () => {
  it('builds the nested path from the slugified question and writes a kind:chat fence', async () => {
    const vault = fakeVault();
    const store = new ChatStore(vault.ports);
    const { path, content } = await store.create(NOW, 'Was ist die Rigg-Aufteilung?', 'zai-glm', 'glm-4.7');
    expect(path).toBe('chats/2026/09/2026-09-13-was-ist-die-rigg-aufteilung.md');

    await store.save(path, content);
    expect(vault.written).toEqual([path]);

    const view = parseChatNote(vault.files.get(path)!);
    expect(view.frontmatter.kind).toBe('chat');
    expect(view.frontmatter.provider).toBe('zai-glm');
    expect(view.frontmatter.model).toBe('glm-4.7');
    expect(view.frontmatter.title).toBe('Was ist die Rigg-Aufteilung?');
    expect(view.frontmatter.created).toBe('2026-09-13T14:32:00');
    expect(view.frontmatter.updated).toBe('2026-09-13T14:32:00');
    expect(view.turns).toHaveLength(0);
    // Dates are quoted strings (schema rule); kind stays plain.
    expect(vault.files.get(path)).toContain("kind: chat\n");
    expect(vault.files.get(path)).toContain("created: \"2026-09-13T14:32:00\"");
  });

  it('uniques against existing siblings with -2/-3 suffixes', async () => {
    const vault = fakeVault({
      'chats/2026/09/2026-09-13-topic.md': '---\nkind: chat\n---\n',
    });
    const store = new ChatStore(vault.ports);
    const { path } = await store.create(NOW, 'Topic', 'zai-glm', null);
    expect(path).toBe('chats/2026/09/2026-09-13-topic-2.md');
  });

  it('writes a quoted note: binding when a doc key is given, omits it when null', async () => {
    const vault = fakeVault();
    const store = new ChatStore(vault.ports);

    const bound = await store.create(NOW, 'Bound', 'zai-glm', null, 'v1::daily/a.md');
    expect(bound.content).toContain('note: "v1::daily/a.md"');
    const boundView = parseChatNote(bound.content);
    expect(boundView.frontmatter.note).toBe('v1::daily/a.md');

    const unbound = await store.create(NOW, 'Unbound 2', 'zai-glm', null, null);
    expect(unbound.content).not.toContain('note:');
    expect(parseChatNote(unbound.content).frontmatter.note).toBeNull();
  });

  it('listChats surfaces the note binding, newest first', async () => {
    const vault = fakeVault({
      'chats/2026/09/2026-09-13-old.md':
        '---\nkind: chat\ntitle: Old\nnote: "v1::a.md"\nupdated: "2026-09-13T10:00:00"\n---\n',
      'chats/2026/09/2026-09-13-new.md':
        '---\nkind: chat\ntitle: New\nupdated: "2026-09-13T11:00:00"\n---\n',
    });
    const store = new ChatStore(vault.ports);
    const chats = await store.listChats();

    expect(chats.map((chat) => chat.title)).toEqual(['New', 'Old']);
    expect(chats[0]?.note).toBeNull();
    expect(chats[1]?.note).toBe('v1::a.md');
  });
});

describe('ChatStore — append / truncate / outcomes', () => {
  async function storeWithNote() {
    const vault = fakeVault();
    const store = new ChatStore(vault.ports);
    const { path, content } = await store.create(NOW, 'Rigg question', 'zai-glm', 'glm-4.7');
    await store.save(path, content);
    return { vault, store, path };
  }

  const userTurn = {
    role: 'user' as const,
    at: '2026-09-13T14:32:10',
    meta: {},
    text: 'What is this?',
    attachments: [{ kind: 'note' as const, path: 'daily/a.md' }],
    tool: [],
    context: [],
    contextStatus: null,
    start: 0,
  };

  it('appendTurn writes the turn and bumps updated while keeping user keys', async () => {
    const { vault, store, path } = await storeWithNote();
    // A key the user added by hand:
    vault.files.set(
      path,
      vault.files.get(path)!.replace('---\n', '---\nmy-note: keep me\n'),
    );
    await store.appendTurn(path, userTurn, { model: 'glm-5' }, new Date(2026, 8, 13, 15, 0, 0));
    const view = parseChatNote(vault.files.get(path)!);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0].text).toBe('What is this?');
    expect(view.frontmatter.updated).toBe('2026-09-13T15:00:00');
    expect(view.frontmatter.model).toBe('glm-5');
    expect(vault.files.get(path)).toContain('my-note: keep me');
  });

  it('appendEditOutcome lands in the last assistant turn and bumps updated', async () => {
    const { vault, store, path } = await storeWithNote();
    await store.appendTurn(path, userTurn);
    await store.appendTurn(
      path,
      {
        role: 'assistant',
        at: '2026-09-13T14:32:20',
        meta: { durationMs: 900 },
        text: '[Proposed a change to `daily/a.md`]',
        attachments: [],
        tool: [],
        context: [],
        contextStatus: null,
        start: 0,
      },
      { session: 'sess-1' },
    );
    await store.appendEditOutcome(
      path,
      { path: 'daily/a.md', applied: true, after: '# applied doc' },
      new Date(2026, 8, 13, 16, 0, 0),
    );
    const view = parseChatNote(vault.files.get(path)!);
    expect(view.turns[1].tool).toEqual([
      { kind: 'edit', path: 'daily/a.md', applied: true, after: '# applied doc' },
    ]);
    expect(view.frontmatter.updated).toBe('2026-09-13T16:00:00');
  });

  it('truncateFrom drops the turns and clears the session', async () => {
    const { vault, store, path } = await storeWithNote();
    await store.appendTurn(path, userTurn);
    await store.appendTurn(
      path,
      {
        role: 'assistant',
        at: '2026-09-13T14:32:20',
        meta: {},
        text: 'Because.',
        attachments: [],
        tool: [],
        context: [],
        contextStatus: null,
        start: 0,
      },
      { session: 'sess-1' },
    );
    await store.appendTurn(
      path,
      { ...userTurn, at: '2026-09-13T17:00:00', text: 'second' },
      undefined as never,
    );
    await store.truncateFrom(path, 2, new Date(2026, 8, 13, 17, 1, 0));
    const view = parseChatNote(vault.files.get(path)!);
    expect(view.turns).toHaveLength(2);
    expect(view.frontmatter.session).toBeNull();
    expect(view.frontmatter.updated).toBe('2026-09-13T17:01:00');
  });
});

describe('ChatStore — listChats', () => {
  it('returns title+updated summaries sorted most-recent-first', async () => {
    const vault = fakeVault({
      'chats/2026/09/2026-09-11-a.md': "---\nkind: chat\ntitle: 'Older'\nupdated: '2026-09-11T10:00:00'\n---\n",
      'chats/2026/09/2026-09-13-b.md': "---\nkind: chat\ntitle: 'Newer'\nupdated: '2026-09-13T09:00:00'\n---\n",
      'notes/plain.md': '# not a chat\n',
    });
    const store = new ChatStore(vault.ports);
    const chats = await store.listChats();
    expect(chats.map((c) => c.title)).toEqual(['Newer', 'Older']);
    expect(chats[0].path).toBe('chats/2026/09/2026-09-13-b.md');
  });

  it('tolerates a fenceless (corrupted) chat file: lists it with the path as title', async () => {
    const vault = fakeVault({
      'chats/2026/09/broken.md':
        'frage"---\nkind: chat\ntitle: "x"\n---\n\n## User\n\nalt\n',
      'chats/2026/09/good.md': "---\nkind: chat\ntitle: 'Good'\nupdated: '2026-09-13T09:00:00'\n---\n",
    });
    const store = new ChatStore(vault.ports);
    const chats = await store.listChats();
    // No fence at the start → empty frontmatter degrades, the file still lists.
    expect(chats.map((c) => c.title)).toEqual(['Good', 'chats/2026/09/broken.md']);
    expect(chats[1].updated).toBeNull();
  });

  it('logs chat files it must skip (vanished between listing and read)', async () => {
    const vault = fakeVault({
      'chats/2026/09/good.md': "---\nkind: chat\ntitle: 'Good'\nupdated: '2026-09-13T09:00:00'\n---\n",
    });
    const logs: Array<{ message: string; level?: string }> = [];
    const store = new ChatStore({
      ...vault.ports,
      listMarkdownFiles: async () => [
        ...(await vault.ports.listMarkdownFiles()),
        'chats/2026/09/gone.md',
      ],
      log: (message, level) => {
        logs.push({ message, level });
      },
    });
    const chats = await store.listChats();
    expect(chats.map((c) => c.title)).toEqual(['Good']);
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('warn');
    expect(logs[0].message).toContain('chats/2026/09/gone.md');
  });
});
