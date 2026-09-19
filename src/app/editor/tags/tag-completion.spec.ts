import type { CompletionContext } from '@codemirror/autocomplete';
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

function context(
  match: { from: number; to: number; text: string } | null,
  explicit = false,
): CompletionContext {
  return { explicit, matchBefore: () => match } as unknown as CompletionContext;
}

describe('makeTagCompletionSource (base editor, milestone 33)', () => {
  const source = makeTagCompletionSource({ getTags: () => TAGS }) as (
    ctx: CompletionContext,
  ) => CompletionResultLike | null;

  it('offers prefix matches, most-used first, applying "#tag "', () => {
    const result = source(context({ from: 10, to: 13, text: '#sa' }));
    expect(result?.from).toBe(10);
    expect(result?.options.map((o: { label: string }) => o.label)).toEqual(['#sailing', '#sales']);
    expect(result?.options[0].apply).toBe('#sailing ');
    expect(result?.options[0].detail).toBe('9×');
  });

  it('returns null on a bare # unless completion was explicitly requested', () => {
    expect(source(context({ from: 5, to: 5, text: '#' }))).toBeNull();
    expect(source(context({ from: 5, to: 5, text: '#' }, true))?.options.length).toBe(TAGS.length);
  });

  it('returns null when nothing matches or there is no # token', () => {
    expect(source(context({ from: 0, to: 4, text: '#zzz' }))).toBeNull();
    expect(source(context(null))).toBeNull();
  });

  it('completes a nested tag segment by segment', () => {
    const result = source(context({ from: 2, to: 12, text: '#projekt/fr' }));
    expect(result?.options.map((o) => o.label)).toEqual(['#projekt/frontend']);
    expect(result?.options[0].apply).toBe('#projekt/frontend ');
  });

  it('renders colored option labels when a color resolver is given', () => {
    const colored = makeTagCompletionSource({
      getTags: () => TAGS,
      colorFor: () => '#4f9a90',
    }) as (ctx: CompletionContext) => CompletionResultLike | null;
    const result = colored(context({ from: 0, to: 3, text: '#sa' }));
    const node = result?.options[0].render?.();
    expect(node?.className).toBe('cm-tag-option');
    expect(node?.textContent).toBe('#sailing');
  });
});
