import { MAX_EXTRA_FILES, parseAskPayload } from './ask';
import type { AskRequest } from './ask';
import { parseChatNote, serializeTurn } from './chat-note';
import { buildReplayMessages } from './chat-replay';

/**
 * The vault-context additions to the ask contract and the chat-note grammar:
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
  vaultIds: [],
  web: false,
};

describe('parseAskPayload vaultScope', () => {
  it('defaults a legacy payload (no field) to off', () => {
    const { request } = parseAskPayload({ question: 'q', note: null, extraFiles: [], images: [], chatPath: null, liveEdit: false });
    expect(request.vaultScope).toBe('off');
    expect(request.vaultIds).toEqual([]);
  });

  it('keeps vault/all/custom and normalizes junk', () => {
    const vault = parseAskPayload({ ...baseRequest, vaultScope: 'vault' });
    expect(vault.request.vaultScope).toBe('vault');
    const all = parseAskPayload({ ...baseRequest, vaultScope: 'all' });
    expect(all.request.vaultScope).toBe('all');
    const custom = parseAskPayload({ ...baseRequest, vaultScope: 'custom', vaultIds: ['v1', 'v2'] });
    expect(custom.request.vaultScope).toBe('custom');
    expect(custom.request.vaultIds).toEqual(['v1', 'v2']);
    const junk = parseAskPayload({ ...baseRequest, vaultScope: true });
    expect(junk.request.vaultScope).toBe('off');
  });

  it('rejects a malformed vaultIds field (visible, not silently dropped)', () => {
    expect(() => parseAskPayload({ ...baseRequest, vaultScope: 'custom', vaultIds: 'v1' })).toThrow();
    expect(() => parseAskPayload({ ...baseRequest, vaultScope: 'custom', vaultIds: ['v1', 5] })).toThrow();
    expect(() => parseAskPayload({ ...baseRequest, vaultScope: 'custom', vaultIds: [''] })).toThrow();
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
        { vault: 'Privat', path: 'daily/a.md', heading: 'Motivation', line: 4 },
        { path: 'notes/b.md', heading: 'Laufen', line: 9 },
      ],
      contextStatus: null,
      start: 0,
    };
    const noteText = serializeTurn(turn);
    expect(noteText).toContain('```drey-context');
    const view = parseChatNote(`# Chat\n\n${noteText}\n`);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0].text).toBe('The answer.');
    expect(view.turns[0].context).toEqual(turn.context);
    expect(view.turns[0].contextStatus).toBeNull();
  });

  it('persists the no-hits status: an empty turn still writes the fence', () => {
    const turn = {
      role: 'assistant' as const,
      at: null,
      meta: {},
      text: 'I do not know.',
      attachments: [],
      tool: [],
      context: [],
      contextStatus: { kind: 'empty' as const, floor: 0.3 },
      start: 0,
    };
    const view = parseChatNote(`# Chat\n\n${serializeTurn(turn)}\n`);
    expect(view.turns[0].context).toEqual([]);
    expect(view.turns[0].contextStatus).toEqual({ kind: 'empty', floor: 0.3 });
  });

  it('roundtrips the unavailable, disabled, unregistered and error statuses', () => {
    const base = {
      role: 'assistant' as const,
      at: null,
      meta: {},
      text: '…',
      attachments: [],
      tool: [],
      context: [],
      start: 0,
    };
    const unavailable = parseChatNote(
      serializeTurn({ ...base, contextStatus: { kind: 'unavailable' } }),
    );
    expect(unavailable.turns[0].contextStatus).toEqual({ kind: 'unavailable' });
    const plainEmpty = parseChatNote(serializeTurn({ ...base, contextStatus: { kind: 'empty' } }));
    expect(plainEmpty.turns[0].contextStatus).toEqual({ kind: 'empty' });
    const disabled = parseChatNote(serializeTurn({ ...base, contextStatus: { kind: 'disabled' } }));
    expect(disabled.turns[0].contextStatus).toEqual({ kind: 'disabled' });
    const unregistered = parseChatNote(
      serializeTurn({ ...base, contextStatus: { kind: 'unregistered' } }),
    );
    expect(unregistered.turns[0].contextStatus).toEqual({ kind: 'unregistered' });
    const failed = parseChatNote(
      serializeTurn({ ...base, contextStatus: { kind: 'error', message: 'index gone' } }),
    );
    expect(failed.turns[0].contextStatus).toEqual({ kind: 'error', message: 'index gone' });
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
      '{"status":"nonsense"}',
      '{"status":"error"}',
      '```',
      '',
    ].join('\n');
    const view = parseChatNote(note);
    expect(view.turns[0].context).toEqual([{ path: 'ok.md', heading: 'H', line: 2 }]);
    expect(view.turns[0].contextStatus).toBeNull();
  });

  it('turns without context parse to an empty list', () => {
    const view = parseChatNote('## User\n\nhello\n');
    expect(view.turns[0].context).toEqual([]);
    expect(view.turns[0].contextStatus).toBeNull();
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
        contextStatus: null,
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
        contextStatus: null,
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
        contextStatus: null,
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
        contextStatus: null,
        start: 0,
      },
    ];
    const result = await buildReplayMessages(turns, async () => null);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe('[Vault context used for this answer: x.md — X]');
  });
});
