import type { CompletionContext } from '@codemirror/autocomplete';
import { makeTagCompletionSource } from '../../../plugins/tags/renderer/extensions';
import type { TagEntry } from '../../../plugins/tags/shared/search.js';

const TAGS: TagEntry[] = [
  { tag: 'sailing', count: 9 },
  { tag: 'sales', count: 2 },
  { tag: 'projekt/frontend', count: 5 },
  { tag: 'projekt/backend', count: 3 },
];

interface CompletionResultLike {
  from: number;
  options: Array<{ label: string; apply?: string; detail?: string }>;
  validFor?: RegExp;
}

function context(
  match: { from: number; to: number; text: string } | null,
  explicit = false,
): CompletionContext {
  return { explicit, matchBefore: () => match } as unknown as CompletionContext;
}

describe('makeTagCompletionSource', () => {
  const source = makeTagCompletionSource(() => TAGS) as (
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
});
