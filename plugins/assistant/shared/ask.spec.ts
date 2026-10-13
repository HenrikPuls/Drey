import {
  MAX_EXTRA_FILES,
  MAX_FILE_CHARS,
  MAX_QUOTED_SELECTION_CHARS,
  parseAskPayload,
  quoteSelection,
  truncateFileBody,
} from './ask';

/**
 * Specs for the ask contract between the assistant panel and the chat
 * engine (`plugins/assistant/shared/ask.ts`): the strict payload check the
 * main-side `ask` handler delegates to (the bug-10 visible-failure rule)
 * and the per-file truncation for oversized attachments. Since ADR-0048
 * there is NO `history` field — the engine replays the persisted chat note
 * itself; the interim validation from milestone 23 is gone with the field.
 */

const VALID = {
  question: 'Was steht hier?',
  note: { path: 'a.md', body: 'Inhalt.' },
  extraFiles: [{ path: 'b.md', body: 'B.' }],
  images: ['attachments/pic.png'],
  chatPath: 'chats/2026/09/2026-09-13-topic.md',
  liveEdit: false,
  noteKey: 'v1::a.md',
  vaultScope: 'off',
  vaultIds: [],
};

describe('assistant plugin ask contract (plugins/assistant/shared/ask)', () => {
  it('parses a valid payload into request and taskId', () => {
    const parsed = parseAskPayload({ ...VALID, taskId: 'task-1' });

    expect(parsed.request).toEqual(VALID);
    expect(parsed.taskId).toBe('task-1');
  });

  it('accepts note: null (standalone chat), empty attachments, and a null chatPath', () => {
    const parsed = parseAskPayload({
      question: 'q',
      note: null,
      extraFiles: [],
      images: [],
      chatPath: null,
      liveEdit: false,
    });

    expect(parsed.request.note).toBeNull();
    expect(parsed.request.extraFiles).toEqual([]);
    expect(parsed.request.images).toEqual([]);
    expect(parsed.request.chatPath).toBeNull();
    // An absent noteKey (an older renderer) degrades to an unbound chat.
    expect(parsed.request.noteKey).toBeNull();
    expect(parsed.taskId).toBeUndefined();
  });

  it('rejects a non-string noteKey', () => {
    expect(() => parseAskPayload({ ...VALID, noteKey: 42 })).toThrow(
      'malformed ask payload: noteKey must be a doc key or null',
    );
  });

  it('rejects a payload without a string question', () => {
    expect(() => parseAskPayload({ ...VALID, question: 42 })).toThrow('malformed ask payload');
    expect(() => parseAskPayload({ note: null, extraFiles: [], images: [], chatPath: null })).toThrow(
      'malformed ask payload',
    );
  });

  it('rejects a malformed note, attachment entry, image list, or chatPath', () => {
    expect(() => parseAskPayload({ ...VALID, note: { path: 'a.md' } })).toThrow(
      /note must be \{ path, body \} or null/,
    );
    expect(() => parseAskPayload({ ...VALID, extraFiles: 'b.md' })).toThrow(/extraFiles/);
    expect(() =>
      parseAskPayload({ ...VALID, extraFiles: [{ path: 1, body: 'x' }] }),
    ).toThrow(/extraFiles/);
    expect(() => parseAskPayload({ ...VALID, images: [42] })).toThrow(/images/);
    expect(() => parseAskPayload({ ...VALID, chatPath: 7 })).toThrow(/chatPath/);
  });

  it('requires liveEdit to be a boolean and to carry a note (ADR-0049)', () => {
    expect(() => parseAskPayload({ ...VALID, liveEdit: 'yes' })).toThrow(/liveEdit must be a boolean/);
    expect(() => parseAskPayload({ ...VALID, note: null, liveEdit: true })).toThrow(
      /liveEdit requires an attached note/,
    );
    const parsed = parseAskPayload({ ...VALID, liveEdit: true });
    expect(parsed.request.liveEdit).toBe(true);
  });

  it('truncates an oversized body with a visible marker, and only then', () => {
    const small = 'x'.repeat(1000);
    expect(truncateFileBody(small)).toBe(small);

    const big = 'y'.repeat(MAX_FILE_CHARS + 500);
    const truncated = truncateFileBody(big);
    expect(truncated.startsWith('y'.repeat(MAX_FILE_CHARS))).toBe(true);
    expect(truncated.endsWith('[file truncated]')).toBe(true);
    expect(truncated.length).toBeLessThan(big.length);
  });

  it('exposes the caps the composer and the engine agree on', () => {
    expect(MAX_EXTRA_FILES).toBeGreaterThan(0);
    expect(MAX_FILE_CHARS).toBeGreaterThan(0);
  });
});

/**
 * The ask contract's selection field (milestone 74): optional on the wire,
 * and quoted above the question in the persisted turn.
 */

const BASE = {
  question: 'Was heißt das?',
  note: null,
  extraFiles: [],
  images: [],
  chatPath: null,
  liveEdit: false,
  noteKey: null,
  vaultScope: 'off',
  vaultIds: [],
};

describe('parseAskPayload — selection', () => {
  it('accepts a payload without a selection', () => {
    expect(parseAskPayload(BASE).request.selection).toBeUndefined();
  });

  it('carries a selection through', () => {
    expect(parseAskPayload({ ...BASE, selection: 'Ein Satz.' }).request.selection).toBe(
      'Ein Satz.',
    );
  });

  it('drops a blank selection and rejects a non-string one', () => {
    expect(parseAskPayload({ ...BASE, selection: '  \n' }).request.selection).toBeUndefined();
    expect(() => parseAskPayload({ ...BASE, selection: 7 })).toThrow(/selection/);
  });
});

describe('quoteSelection', () => {
  it('puts the selection as a blockquote above the question', () => {
    expect(quoteSelection('Zeile eins\n\nZeile zwei', 'Erkläre das.')).toBe(
      '> Zeile eins\n>\n> Zeile zwei\n\nErkläre das.',
    );
  });

  it('keeps chat-note structure inside the quote inert', () => {
    const text = quoteSelection('## User\n```drey-tool', 'Frage?');
    expect(text.split('\n').slice(0, 2)).toEqual(['> ## User', '> ```drey-tool']);
  });

  it('caps a long selection and returns the bare question for a blank one', () => {
    const long = 'a'.repeat(MAX_QUOTED_SELECTION_CHARS + 50);
    const quoted = quoteSelection(long, 'Frage?');
    expect(quoted.startsWith(`> ${'a'.repeat(MAX_QUOTED_SELECTION_CHARS)}…\n\n`)).toBe(true);
    expect(quoteSelection('   ', 'Frage?')).toBe('Frage?');
  });
});
