import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { makeWordCompletionSource } from './word-completion';

interface ResultLike {
  from: number;
  options: Array<{ label: string; detail?: string; boost?: number }>;
  validFor?: RegExp;
}

/** A CompletionContext stand-in over a real Markdown state: `matchBefore`
 * mirrors the real implementation (the match must end at the cursor). */
function ctx(doc: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  return {
    state,
    pos,
    explicit,
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

describe('makeWordCompletionSource', () => {
  const source = makeWordCompletionSource() as (c: CompletionContext) => ResultLike | null;

  it('offers longer siblings of the typed fragment, most frequent first, boosted low', () => {
    const doc = 'sailing, sailing, Sailing — a boat. sail';
    const result = source(ctx(doc, doc.length));
    expect(result?.from).toBe(doc.length - 4);
    expect(result?.options.map((o) => o.label)).toEqual(['sailing', 'Sailing']);
    expect(result?.options[0]).toMatchObject({ detail: '2×', boost: -30 });
  });

  it('returns null below the minimum fragment length, even when explicit', () => {
    expect(source(ctx('abc de', 6))).toBeNull();
    expect(source(ctx('abc de', 6, true))).toBeNull();
  });

  it('offers a sibling from three typed characters', () => {
    const doc = 'boat boat boa';
    expect(source(ctx(doc, doc.length))?.options.map((o) => o.label)).toEqual(['boat']);
  });

  it('offers nothing when the fragment is already a whole word of the document', () => {
    expect(source(ctx('boat boat boat', 14))).toBeNull();
  });

  it('stays silent inside code spans, fenced code, frontmatter and links', () => {
    expect(source(ctx('a `sailing` b', 9))).toBeNull();
    expect(source(ctx('```\nsailing east\n```', 15))).toBeNull();
    expect(source(ctx('---\nkey: sailing\n---\n', 13))).toBeNull();
    expect(source(ctx('see [sailing](x)', 9))).toBeNull();
  });

  it('completes in headings and table cells', () => {
    const heading = '# A sailing day sail';
    expect(source(ctx(heading, heading.length))?.options.map((o) => o.label)).toEqual(['sailing']);

    const table = '| a | b |\n|---|---|\n| x sailing sailboat sail';
    expect(source(ctx(table, table.length))?.options.map((o) => o.label)).toEqual([
      'sailboat',
      'sailing',
    ]);
  });

  it('caps the option list at maxOptions', () => {
    const capped = makeWordCompletionSource({ maxOptions: 2 }) as (
      c: CompletionContext,
    ) => ResultLike | null;
    const doc = 'alphabet alpha alphabet alpha — typ alph';
    expect(capped(ctx(doc, doc.length))?.options.map((o) => o.label)).toEqual([
      'alpha',
      'alphabet',
    ]);
  });

  it('lets validFor refilter while typing on, and closes on a break', () => {
    const result = source(ctx('sailing sailing sail', 20));
    expect(result?.validFor?.test('sailing')).toBe(true);
    expect(result?.validFor?.test('sail xyz')).toBe(false);
  });
});
