import {
  CHAT_KIND,
  appendEditOutcome,
  appendTurn,
  chatNotePathFor,
  isAttachmentLine,
  parseChatNote,
  readChatNoteFrontmatter,
  serializeTurn,
  slugifyChatTitle,
  toolEntriesFromTrace,
  toolEntryLine,
  truncateFrom,
  uniqueChatPath,
  ChatNoteTurn,
} from '../../../plugins/assistant/shared/chat-note';
import type { ChatMessage } from '../../../shared/llm';

function userTurn(overrides: Partial<ChatNoteTurn> = {}): ChatNoteTurn {
  return {
    role: 'user',
    at: '2026-09-13T14:32:00',
    meta: {},
    text: 'Please summarise the attached note.',
    attachments: [{ kind: 'note', path: 'daily/2026/09/2026-09-13.md' }],
    tool: [],
    context: [],
    start: 0,
    ...overrides,
  };
}

describe('chat-note grammar — parse/serialize round-trip', () => {
  const note = [
    '---',
    `${'kind'}: chat`,
    "provider: 'zai-glm'",
    'title: How do I rig the spinnaker',
    "created: '2026-09-13'",
    "updated: '2026-09-13T14:32:00'",
    '---',
    '',
    '## User — 2026-09-13T14:32:00',
    '',
    'Please summarise the attached note.',
    '',
    '[[daily/2026/09/2026-09-13.md]]',
    '![photo](attachments/20260913-ab12cd.png)',
    '',
    '## Assistant — 2026-09-13T14:32:09',
    '<!-- drey: {"durationMs":8123,"model":"glm-4.7"} -->',
    '',
    'Here is the summary …',
    '',
    '```drey-tool',
    '{"call":{"id":"t1","name":"vault_search","arguments":{"query":"sailing"}}}',
    '{"result":{"id":"t1","content":"3 hits"}}',
    '```',
    '',
  ].join('\n');

  it('reads frontmatter, turns, attachments, meta and tool lines', () => {
    const view = parseChatNote(note);
    expect(view.frontmatter.kind).toBe(CHAT_KIND);
    expect(view.frontmatter.provider).toBe('zai-glm');
    expect(view.frontmatter.title).toBe('How do I rig the spinnaker');
    expect(view.turns).toHaveLength(2);

    const [user, assistant] = view.turns;
    expect(user.role).toBe('user');
    expect(user.at).toBe('2026-09-13T14:32:00');
    expect(user.text).toBe('Please summarise the attached note.');
    expect(user.attachments).toEqual([
      { kind: 'note', path: 'daily/2026/09/2026-09-13.md' },
      { kind: 'image', path: 'attachments/20260913-ab12cd.png', alt: 'photo' },
    ]);
    expect(assistant.role).toBe('assistant');
    expect(assistant.meta).toEqual({ durationMs: 8123, model: 'glm-4.7' });
    expect(assistant.text).toBe('Here is the summary …');
    expect(assistant.tool).toEqual([
      { kind: 'call', id: 't1', name: 'vault_search', arguments: { query: 'sailing' } },
      { kind: 'result', id: 't1', content: '3 hits' },
    ]);
  });

  it('round-trips: appending serialized parsed turns reproduces the note', () => {
    const view = parseChatNote(note);
    const body = view.turns.reduce((text, turn) => appendTurn(text, turn), '');
    // `start` is the offset in ITS text — a rebuilt body has different offsets.
    const withoutStart = (turns: ChatNoteTurn[]) =>
      turns.map(({ start, ...rest }) => rest);
    expect(withoutStart(parseChatNote(body).turns)).toEqual(withoutStart(view.turns));
  });

  it('appending a turn to a note keeps existing content byte-exact', () => {
    const next = appendTurn(note, userTurn({ at: '2026-09-13T14:40:00', attachments: [] }));
    expect(next.startsWith(note)).toBe(true);
    const view = parseChatNote(next);
    expect(view.turns).toHaveLength(3);
    expect(view.turns[2].text).toBe('Please summarise the attached note.');
  });
});

describe('chat-note grammar — defensive parse', () => {
  it('returns empty turns for a note without headings and never throws', () => {
    expect(parseChatNote('just prose\n')).toEqual({
      frontmatter: {
        kind: null,
        provider: null,
        model: null,
        session: null,
        title: null,
        created: null,
        updated: null,
        note: null,
      },
      turns: [],
    });
  });

  it('drops malformed tool lines and keeps the parseable ones', () => {
    const note = [
      '## Assistant',
      '',
      'text',
      '',
      '```drey-tool',
      'not json at all',
      '{"nonsense":true}',
      '{"call":{"name":"vault_read","arguments":"{}"}}',
      '```',
      '',
    ].join('\n');
    const view = parseChatNote(note);
    expect(view.turns[0].tool).toEqual([
      { kind: 'call', id: '', name: 'vault_read', arguments: '{}' },
    ]);
  });

  it('tolerates CRLF and a -- separator in the heading', () => {
    const view = parseChatNote('## User -- 2026-09-13T10:00:00\r\n\r\nhello\r\n');
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0].at).toBe('2026-09-13T10:00:00');
    expect(view.turns[0].text).toBe('hello');
  });

  it('keeps a link line as prose when it is not a trailing blank-separated block', () => {
    const view = parseChatNote('## User\n\nsee [[daily/x.md]] for details\n');
    expect(view.turns[0].attachments).toEqual([]);
    expect(view.turns[0].text).toBe('see [[daily/x.md]] for details');
  });
});

describe('chat-note grammar — tool helpers', () => {
  it('maps a provider toolTrace onto persisted entries in order', () => {
    const trace: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'vault_search', arguments: '{"query":"x"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: 'hits' },
    ];
    expect(toolEntriesFromTrace(trace)).toEqual([
      { kind: 'call', id: 'a', name: 'vault_search', arguments: '{"query":"x"}' },
      { kind: 'result', id: 'a', content: 'hits' },
    ]);
    expect(toolEntriesFromTrace(undefined)).toEqual([]);
  });

  it('round-trips entries through their JSON line form', () => {
    const line = toolEntryLine({
      kind: 'edit',
      path: 'daily/a.md',
      applied: true,
      after: '# doc',
    });
    expect(line).toBe(
      '{"edit":{"path":"daily/a.md","applied":true,"after":"# doc"}}',
    );
  });
});

describe('chat-note grammar — edit outcomes', () => {
  it('appends the outcome line into the last assistant fence before its closing fence', () => {
    const note = [
      '## User',
      '',
      'fix the heading',
      '',
      '## Assistant',
      '',
      '[Proposed a change to `daily/a.md`]',
      '',
      '```drey-tool',
      '{"call":{"id":"t","name":"vault_read","arguments":{}}}',
      '{"result":{"id":"t","content":"…"}}',
      '```',
      '',
    ].join('\n');
    const out = appendEditOutcome(note, { path: 'daily/a.md', applied: true, after: '# fixed' });
    expect(out).toContain(
      '{"result":{"id":"t","content":"…"}}\n{"edit":{"path":"daily/a.md","applied":true,"after":"# fixed"}}\n```',
    );
    // and it parses back
    const view = parseChatNote(out);
    expect(view.turns[1].tool).toEqual([
      { kind: 'call', id: 't', name: 'vault_read', arguments: {} },
      { kind: 'result', id: 't', content: '…' },
      { kind: 'edit', path: 'daily/a.md', applied: true, after: '# fixed' },
    ]);
  });

  it('creates a fence when the proposal turn had no tool rounds', () => {
    const note = '## Assistant\n\n[Proposed a change to `a.md`]\n';
    const out = appendEditOutcome(note, { path: 'a.md', applied: false });
    expect(parseChatNote(out).turns[0].tool).toEqual([
      { kind: 'edit', path: 'a.md', applied: false },
    ]);
  });
});

describe('chat-note grammar — truncation', () => {
  it('drops every turn from the given index on and keeps earlier text', () => {
    const note = appendTurn(
      appendTurn('---\nkind: chat\n---\n', userTurn()),
      {
        role: 'assistant',
        at: '2026-09-13T14:32:09',
        meta: {},
        text: 'Summary.',
        attachments: [],
        tool: [],
        context: [],
        start: 0,
      },
    );
    const third = appendTurn(note, userTurn({ at: '2026-09-13T15:00:00', attachments: [] }));
    const cut = truncateFrom(third, 2);
    expect(parseChatNote(cut).turns).toHaveLength(2);
    expect(cut.startsWith('---\nkind: chat\n---')).toBe(true);
  });

  it('returns the note unchanged for an out-of-range index', () => {
    const note = '## User\n\nhi\n';
    expect(truncateFrom(note, 7)).toBe(note);
  });
});

describe('chat-note grammar — paths and slugs', () => {
  it('nests per year/month like daily/', () => {
    expect(chatNotePathFor('2026-09-13', 'rigging-question')).toBe(
      'chats/2026/09/2026-09-13-rigging-question.md',
    );
  });

  it('uniques with numeric suffixes, not copy-style', () => {
    const existing = ['chats/2026/09/2026-09-13-rigging.md'];
    expect(uniqueChatPath('chats/2026/09/2026-09-13-rigging.md', existing)).toBe(
      'chats/2026/09/2026-09-13-rigging-2.md',
    );
    expect(uniqueChatPath('chats/2026/09/2026-09-13-new.md', existing)).toBe(
      'chats/2026/09/2026-09-13-new.md',
    );
  });

  it('slugifies umlauts and caps on a dash boundary', () => {
    expect(slugifyChatTitle('Was ist die Rigg-Aufteilung?')).toBe('was-ist-die-rigg-aufteilung');
    expect(slugifyChatTitle('')).toBe('chat');
    expect(slugifyChatTitle('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe('chat-note grammar — small helpers', () => {
  it('recognises exactly-one-link lines only', () => {
    expect(isAttachmentLine('[[a.md]]')).toEqual({ kind: 'note', path: 'a.md' });
    expect(isAttachmentLine('![alt](img/a.png)')).toEqual({
      kind: 'image',
      path: 'img/a.png',
      alt: 'alt',
    });
    expect(isAttachmentLine('look at [[a.md]]')).toBeNull();
    expect(isAttachmentLine('- [[a.md]]')).toBeNull();
  });

  it('reads frontmatter scalars with quote stripping', () => {
    expect(
      readChatNoteFrontmatter('---\nsession: "abc"\nmodel: plain\nnote: "v1::a.md"\n---\n'),
    ).toEqual({
      kind: null,
      provider: null,
      model: 'plain',
      session: 'abc',
      title: null,
      created: null,
      updated: null,
      note: 'v1::a.md',
    });
  });

  it('serializeTurn puts the meta comment under the heading and the fence last', () => {
    const text = serializeTurn({
      role: 'assistant',
      at: '2026-09-13T14:32:09',
      meta: { durationMs: 100 },
      text: 'Answer.',
      attachments: [],
      tool: [{ kind: 'call', id: 'a', name: 'vault_search', arguments: '{}' }],
      context: [],
      start: 0,
    });
    expect(text).toBe(
      [
        '## Assistant — 2026-09-13T14:32:09',
        '<!-- drey: {"durationMs":100} -->',
        '',
        'Answer.',
        '',
        '```drey-tool',
        '{"call":{"id":"a","name":"vault_search","arguments":"{}"}}',
        '```',
      ].join('\n'),
    );
  });
});
