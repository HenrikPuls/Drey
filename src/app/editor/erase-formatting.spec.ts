import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { extendedMarkdown } from './markdown-extensions';
import { eraseFormattingEdit } from './erase-formatting';

function state(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [markdown({ base: markdownLanguage, extensions: extendedMarkdown })],
  });
}

/** The edit applied to the document: [text, anchor, head], or null. */
function applied(doc: string, anchor: number, head = anchor): [string, number, number] | null {
  const edit = eraseFormattingEdit(state(doc, anchor, head));
  if (edit === null) {
    return null;
  }
  let text = doc;
  for (const ch of [...edit.changes].sort((a, b) => b.from - a.from)) {
    text = text.slice(0, ch.from) + text.slice(ch.to);
  }
  return [text, edit.anchor, edit.head];
}

describe('eraseFormattingEdit (caret: peel the outermost layer)', () => {
  it('unwraps bold, keeping the content and the caret offset', () => {
    const result = applied('a **bold** b', 6);
    expect(result?.[0]).toBe('a bold b');
    expect(result?.[1]).toBe(4); // caret stays between 'b' and 'o'
  });

  it('peels the outermost wrap first, then the next', () => {
    expect(applied('**fett ==rot==**', 9)?.[0]).toBe('fett ==rot==');
    expect(applied('fett ==rot==', 7)?.[0]).toBe('fett rot');
  });

  it('peels emphasis before strong in ***x*** (the grammar nests them)', () => {
    expect(applied('***x***', 4)?.[0]).toBe('**x**');
    expect(applied('**x**', 3)?.[0]).toBe('x');
  });

  it('unwraps every inline construct of the dialect', () => {
    expect(applied('~gone~ strike', 2)?.[0]).toBe('gone strike'); // ~~…~~ (strike)
    expect(applied('==gone==', 4)?.[0]).toBe('gone');
    expect(applied('H~2~O', 3)?.[0]).toBe('H2O');
    expect(applied('X^2^', 3)?.[0]).toBe('X2');
    expect(applied('a `code` b', 5)?.[0]).toBe('a code b');
    expect(applied('$a^2$', 3)?.[0]).toBe('a^2');
  });

  it('keeps a link label and drops the url part', () => {
    const result = applied('see [label](https://x) here', 8);
    expect(result?.[0]).toBe('see label here');
  });

  it('peels the inline wrap inside block formatting, never the block itself', () => {
    expect(applied('> **quoted**', 6)?.[0]).toBe('> quoted');
    expect(applied('# **heading**', 8)?.[0]).toBe('# heading');
    expect(applied('> [!NOTE]\n> **body**', 14)?.[0]).toBe('> [!NOTE]\n> body');
  });

  it('is a no-op without formatting (no undo step)', () => {
    expect(applied('plain text', 4)).toBeNull();
    expect(applied('a **bold** b', 0)).toBeNull(); // caret outside the wrap
    expect(applied('- task item', 4)).toBeNull(); // lists are block -- toggles exist
  });
});

describe('eraseFormattingEdit (selection: wipe what it overlaps)', () => {
  it('clears every wrap the selection touches, in one change', () => {
    expect(applied('**a** und ==b== und `c`', 0, 22)?.[0]).toBe('a und b und c');
  });

  it('unwraps a construct the selection only partly overlaps', () => {
    expect(applied('**a** and more', 0, 3)?.[0]).toBe('a and more');
  });

  it('keeps nested content and maps the selection onto it', () => {
    const result = applied('**fett ==rot==** und', 0, 16);
    expect(result?.[0]).toBe('fett rot und');
    expect(result?.[1]).toBe(0);
    expect(result?.[2]).toBe(8); // right after "rot", four markers deleted before it
  });

  it('keeps link labels across a wipe', () => {
    expect(applied('x [a](u) y [b](v)', 0, 17)?.[0]).toBe('x a y b');
  });

  it('is a no-op when the selection covers no formatting', () => {
    expect(applied('plain words here', 2, 9)).toBeNull();
  });
});
