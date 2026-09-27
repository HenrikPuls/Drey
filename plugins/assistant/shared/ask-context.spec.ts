import { MAX_EXTRA_FILES, parseAskPayload } from './ask';
import type { AskRequest } from './ask';
import { DEFAULT_SEMANTIC_MODEL, encodeVector } from './semantic';
import { parseChatNote, serializeTurn } from './chat-note';
import { buildReplayMessages } from './chat-replay';

/**
 * The ADR-0055 additions to the ask contract and the chat-note grammar:
 * the `vaultScope` field (with legacy tolerance), the ```drey-context
 * fence roundtrip, and the compact replay line that keeps follow-ups
 * small.
 */

const baseRequest: AskRequest = {
  question: 'q',
  note: null,
  extraFiles: [],
  images: [],
  chatPath: null,
  liveEdit: false,
  noteKey: null,
  vaultScope: 'off',
};

describe('parseAskPayload vaultScope', () => {
  it('defaults a legacy payload (no field) to off', () => {
    const { request } = parseAskPayload({ question: 'q', note: null, extraFiles: [], images: [], chatPath: null, liveEdit: false });
    expect(request.vaultScope).toBe('off');
  });

  it('keeps vault/all and normalizes junk', () => {
    const vault = parseAskPayload({ ...baseRequest, vaultScope: 'vault' });
    expect(vault.request.vaultScope).toBe('vault');
    const all = parseAskPayload({ ...baseRequest, vaultScope: 'all' });
    expect(all.request.vaultScope).toBe('all');
    const junk = parseAskPayload({ ...baseRequest, vaultScope: true });
    expect(junk.request.vaultScope).toBe('off');
  });

  it('still rejects a malformed core payload', () => {
    expect(() => parseAskPayload({ ...baseRequest, question: 5 })).toThrow();
  });
});

describe('the ```drey-context fence', () => {
  it('roundtrips through serialize + parse and stays out of the turn text', () => {
    const turn = {
      role: 'assistant' as const,
      at: null,
      meta: {},
      text: 'The answer.',
      attachments: [],
      tool: [],
      context: [
        { path: 'daily/a.md', heading: 'Motivation', line: 4 },
        { path: 'notes/b.md', heading: 'Laufen', line: 9 },
      ],
      start: 0,
    };
    const noteText = serializeTurn(turn);
    expect(noteText).toContain('```drey-context');
    const view = parseChatNote(`# Chat\n\n${noteText}\n`);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0].text).toBe('The answer.');
    expect(view.turns[0].context).toEqual(turn.context);
  });

  it('tolerates a hand-mangled context line (dropped, not fatal)', () => {
    const note = [
      '## Assistant',
      '',
      'Answer.',
      '',
      '```drey-context',
      '{not json',
      '{"cite":{"path":"ok.md","heading":"H","line":2}}',
      '```',
      '',
    ].join('\n');
    const view = parseChatNote(note);
    expect(view.turns[0].context).toEqual([{ path: 'ok.md', heading: 'H', line: 2 }]);
  });

  it('turns without context parse to an empty list', () => {
    const view = parseChatNote('## User\n\nhello\n');
    expect(view.turns[0].context).toEqual([]);
  });
});

describe('replay with context citations', () => {
  it('appends ONE compact line — section text never replays', async () => {
    const turns = [
      {
        role: 'user' as const,
        at: null,
        meta: {},
        text: 'Was habe ich über Motivation geschrieben?',
        attachments: [],
        tool: [],
        context: [],
        start: 0,
      },
      {
        role: 'assistant' as const,
        at: null,
        meta: {},
        text: 'Einiges.',
        attachments: [],
        tool: [],
        context: [{ path: 'daily/a.md', heading: 'Motivation', line: 4 }],
        start: 0,
      },
      {
        role: 'user' as const,
        at: null,
        meta: {},
        text: 'Und nochmal?',
        attachments: [],
        tool: [],
        context: [],
        start: 0,
      },
    ];
    const result = await buildReplayMessages(turns, async () => null);
    const assistant = result.messages.find((m) => m.role === 'assistant' && m.content?.includes('Einiges.'));
    expect(assistant?.content).toContain('[Vault context used for this answer: daily/a.md — Motivation]');
    expect(assistant?.content).not.toContain('section text');
  });

  it('an assistant turn without text still cites its context', async () => {
    const turns = [
      {
        role: 'assistant' as const,
        at: null,
        meta: {},
        text: '',
        attachments: [],
        tool: [],
        context: [{ path: 'x.md', heading: 'X', line: 1 }],
        start: 0,
      },
    ];
    const result = await buildReplayMessages(turns, async () => null);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('[Vault context used for this answer: x.md — X]');
  });
});

describe('vector encoding fits the index file', () => {
  it('encodes a 384-dim vector at base64 size (4 bytes → ~5.3 chars)', () => {
    const vector = Float32Array.from({ length: 384 }, (_, i) => (i % 7) / 7);
    const encoded = encodeVector(vector);
    expect(encoded.length).toBe(2048);
  });
});

describe('ask caps unchanged', () => {
  it('keeps the extra-file cap', () => {
    expect(MAX_EXTRA_FILES).toBe(10);
  });
});

describe('model default', () => {
  it('stays the small multilingual e5', () => {
    expect(DEFAULT_SEMANTIC_MODEL).toBe('Xenova/multilingual-e5-small');
  });
});
