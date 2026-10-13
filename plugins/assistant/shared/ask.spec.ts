import { describe, expect, it } from 'vitest';
import { MAX_QUOTED_SELECTION_CHARS, parseAskPayload, quoteSelection } from './ask';

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
