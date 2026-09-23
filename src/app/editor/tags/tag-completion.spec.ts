import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import type { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { makeTagCompletionSource } from './tag-completion';
import type { TagEntry } from '../../../../shared/plugin-api/search-types';

const TAGS: TagEntry[] = [
  { tag: 'sailing', count: 9 },
  { tag: 'sales', count: 2 },
  { tag: 'projekt/frontend', count: 5 },
  { tag: 'projekt/backend', count: 3 },
];

interface CompletionResultLike {
  from: number;
  options: Array<{ label: string; apply?: string; detail?: string; render?: () => HTMLElement }>;
  validFor?: RegExp;
}

/** A CompletionContext stand-in over a real Markdown state: the source
 * reads `state`/`pos` for the shared Markdown-context gate, while
 * `matchBefore` returns the given fixed match (or none). */
function context(
  doc: string,
  pos: number,
  match: { from: number; to: number; text: string } | null,
  explicit = false,
): CompletionContext {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  return { state, pos, explicit, matchBefore: () => match } as unknown as CompletionContext;
}

describe('makeTagCompletionSource (base editor, milestone 33)', () => {
  const source = makeTagCompletionSource({ getTags: () => TAGS }) as (
    ctx: CompletionContext,
  ) => CompletionResultLike | null;

  it('offers prefix matches, most-used first, applying "#tag "', () => {
    const result = source(context('x #sa', 5, { from: 2, to: 5, text: '#sa' }));
    expect(result?.from).toBe(2);
    expect(result?.options.map((o: { label: string }) => o.label)).toEqual(['#sailing', '#sales']);
    expect(result?.options[0].apply).toBe('#sailing ');
    expect(result?.options[0].detail).toBe('9×');
  });

  it('returns null on a bare # unless completion was explicitly requested', () => {
    expect(source(context('x #', 3, { from: 3, to: 3, text: '#' }))).toBeNull();
    expect(source(context('x #', 3, { from: 3, to: 3, text: '#' }, true))?.options.length).toBe(
      TAGS.length,
    );
  });

  it('returns null when nothing matches or there is no # token', () => {
    expect(source(context('x #zzz', 6, { from: 2, to: 6, text: '#zzz' }))).toBeNull();
    expect(source(context('x #sa', 5, null))).toBeNull();
  });

  it('completes a nested tag segment by segment', () => {
    const result = source(
      context('x #projekt/fr', 13, { from: 2, to: 13, text: '#projekt/fr' }),
    );
    expect(result?.options.map((o) => o.label)).toEqual(['#projekt/frontend']);
    expect(result?.options[0].apply).toBe('#projekt/frontend ');
  });

  it('renders colored option labels when a color resolver is given', () => {
    const colored = makeTagCompletionSource({
      getTags: () => TAGS,
      colorFor: () => '#4f9a90',
    }) as (ctx: CompletionContext) => CompletionResultLike | null;
    const result = colored(context('x #sa', 5, { from: 2, to: 5, text: '#sa' }));
    const node = result?.options[0].render?.();
    expect(node?.className).toBe('cm-tag-option');
    expect(node?.textContent).toBe('#sailing');
  });

  it('stays silent inside fenced code, inline code and frontmatter', () => {
    const fence = '```sh\necho "#sa"\n```';
    expect(source(context(fence, 15, { from: 12, to: 15, text: '#sa' }))).toBeNull();
    const span = 'text `#sa` more';
    expect(source(context(span, 9, { from: 6, to: 9, text: '#sa' }))).toBeNull();
    const fm = '---\ntags: "#sa"\n---\n';
    expect(source(context(fm, 14, { from: 11, to: 14, text: '#sa' }))).toBeNull();
  });

  it('still completes inside headings, tables and blockquotes', () => {
    expect(source(context('# H #sa', 7, { from: 5, to: 7, text: '#sa' }))?.options.length).toBe(2);
    const table = '| a | b |\n|---|---|\n| #sa';
    expect(
      source(
        context(table, table.length, {
          from: table.length - 3,
          to: table.length,
          text: '#sa',
        }),
      )?.options.length,
    ).toBe(2);
    expect(source(context('> #sa', 5, { from: 2, to: 5, text: '#sa' }))?.options.length).toBe(2);
  });
});
