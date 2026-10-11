import type { CompletionContext } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { makeEmojiCompletionSource } from './emoji-completion';
import { extendedMarkdown } from '../markdown-extensions';

interface ResultLike {
  from: number;
  options: Array<{ label: string; detail?: string; apply?: string }>;
  validFor?: RegExp;
}

/** A CompletionContext stand-in over a real Markdown state (the shared spec
 *  pattern): `matchBefore` mirrors the real implementation. */
function ctx(doc: string, pos: number): CompletionContext {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: extendedMarkdown })],
  });
  return {
    state,
    pos,
    explicit: false,
    matchBefore: (regexp: RegExp) => {
      const line = state.doc.lineAt(pos);
      const before = state.sliceDoc(line.from, pos);
      const match = regexp.exec(before);
      if (!match || match.index + match[0].length < before.length) {
        return null;
      }
      return { from: line.from + match.index, to: pos, text: match[0] };
    },
  } as unknown as CompletionContext;
}

describe('makeEmojiCompletionSource', () => {
  const source = makeEmojiCompletionSource() as (c: CompletionContext) => ResultLike | null;

  it('offers the curated names for a typed shortcode, prefix first', () => {
    const result = source(ctx('mood :jo', 8))!;
    expect(result.from).toBe(5);
    expect(result.options.map((o) => o.label)).toContain(':joy:');
    // Prefix matches lead; everything after at least contains the query.
    expect(result.options.every((o) => o.label.includes('jo'))).toBe(true);
    expect(result.validFor).toEqual(/^:[a-zA-Z0-9_+-]*:?$/);
  });

  it('matches on substrings after the prefix matches and hoists recents', () => {
    const ranked = makeEmojiCompletionSource({ getRecents: () => ['joy'] }) as (
      c: CompletionContext,
    ) => ResultLike | null;
    const result = ranked(ctx('nice :jo', 8))!;
    expect(result.options[0].label).toBe(':joy:'); // a recent goes first
    expect(result.options.length).toBeGreaterThan(1);
  });

  it('applies :name: over the typed fragment, closing colon included', () => {
    const result = source(ctx('a :joy: b', 7))!;
    expect(result.from).toBe(2);
    expect(result.options.find((o) => o.label === ':joy:')?.apply).toBe(':joy:');
  });


  it('stays quiet behind a word character or digit (times, urls, prose colons)', () => {
    expect(source(ctx('12:30', 5))).toBeNull();
    expect(source(ctx('00:03:48', 8))).toBeNull();
    expect(source(ctx('https://x', 6))).toBeNull();
    expect(source(ctx('Note: folge', 6))).toBeNull();
  });

  it('opens at line start and after whitespace or opening punctuation', () => {
    expect(source(ctx(':jo', 3))).not.toBeNull();
    expect(source(ctx('hi :jo', 6))).not.toBeNull();
    expect(source(ctx('(:jo', 4))).not.toBeNull();
  });

  it('never opens on the bare colon or an unknown fragment', () => {
    expect(source(ctx('hi :', 4))).toBeNull();
    expect(source(ctx('hi :zzzz', 8))).toBeNull();
  });

  it('stays silent inside code, frontmatter, links and math', () => {
    expect(source(ctx('```\n:joy\n```', 8))).toBeNull();
    expect(source(ctx('---\nx: :joy\n---\n', 13))).toBeNull();
    expect(source(ctx('[a](:joy)', 9))).toBeNull();
    expect(source(ctx('$a :joy b$', 9))).toBeNull();
    expect(source(ctx('$$\n:joy\n$$', 8))).toBeNull();
  });
});
