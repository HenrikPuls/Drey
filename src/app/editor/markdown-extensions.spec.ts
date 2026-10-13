import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { extendedMarkdown, footnoteNumbers } from './markdown-extensions';

function tree(doc: string): Tree {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({
        base: markdownLanguage,
        // The surface's exact grammar: built-in Emoji out, curated one in.
        extensions: [{ remove: ['Emoji'] }, ...extendedMarkdown],
      }),
    ],
  });
  return ensureSyntaxTree(state, doc.length, 5000)!;
}

/** Every node of `name`, as `from`/`to` pairs. */
function spans(doc: string, name: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  tree(doc).iterate({
    enter: (node) => {
      if (node.name === name) {
        found.push([node.from, node.to]);
      }
    },
  });
  return found;
}

describe('extendedMarkdown grammar', () => {
  it('parses ==highlight== with marks, and rejects empties and line spans', () => {
    expect(spans('a ==b== c', 'Highlight')).toEqual([[2, 7]]);
    const marks = spans('a ==b== c', 'HighlightMark');
    expect(marks).toEqual([
      [2, 4],
      [5, 7],
    ]);
    expect(spans('====', 'Highlight')).toEqual([]);
    expect(spans('==a\nb==', 'Highlight')).toEqual([]);
  });

  it('parses inline $…$ and same-line $$…$$ math, keeps currency prose', () => {
    expect(spans('$x^2$', 'InlineMath')).toEqual([[0, 5]]);
    expect(spans('a $$E=mc^2$$ b', 'InlineMath')).toEqual([[2, 12]]);
    expect(spans('costs $5 and $6 total', 'InlineMath')).toEqual([]);
    expect(spans('$ spaced$', 'InlineMath')).toEqual([]);
    expect(spans('escaped \\$x$ stays', 'InlineMath')).toEqual([]);
  });

  it('parses $$ display blocks: multiline, single-line, unterminated', () => {
    expect(spans('$$\nx = 1\n$$', 'MathBlock')).toEqual([[0, 11]]);
    expect(spans('$$ x = 1 $$', 'MathBlock')).toEqual([[0, 11]]);
    // A `$$` line interrupts a paragraph, like a fence.
    expect(spans('before\n$$\nx\n', 'MathBlock')).toEqual([[7, 11]]);
    expect(spans('text $$ x $$ inline', 'InlineMath')).toEqual([[5, 12]]);
  });

  it('parses footnote refs and definitions (not link references)', () => {
    expect(spans('claim[^1] and[^my note]', 'FootnoteRef')).toEqual([
      [5, 9],
      [13, 23],
    ]);
    const doc = 'para\n\n[^1]: the note\n';
    expect(spans(doc, 'FootnoteDef')).toEqual([[6, 20]]);
    expect(spans(doc, 'LinkReference')).toEqual([]);
  });

  it('parses curated :emoji: only', () => {
    expect(spans(':joy: and :+1:', 'Emoji')).toEqual([
      [0, 5],
      [10, 14],
    ]);
    expect(spans('at 00:03:48 sharp', 'Emoji')).toEqual([]);
    expect(spans(':not_known:', 'Emoji')).toEqual([]);
  });

  it('numbers footnote definitions in document order, fence-aware', () => {
    const numbers = footnoteNumbers(
      'text[^a]\n\n[^b]: second\n\n[^a]: first\n\n```\n[^c]: in code\n```\n\n[^c]: real\n',
    );
    expect(numbers.get('b')).toBe(1);
    expect(numbers.get('a')).toBe(2);
    expect(numbers.get('c')).toBe(3);
    expect(numbers.size).toBe(3);
  });
});
