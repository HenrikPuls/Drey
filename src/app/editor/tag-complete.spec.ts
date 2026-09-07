import type { CompletionContext } from '@codemirror/autocomplete';
import { makeTagCompletionSource } from './tag-complete';
import { TagEntry } from '../../../shared/ipc-api';

const TAGS: TagEntry[] = [
  { tag: 'sailing', count: 9 },
  { tag: 'sales', count: 2 },
];

function context(
  match: { from: number; to: number; text: string } | null,
  explicit = false,
): CompletionContext {
  return { explicit, matchBefore: () => match } as unknown as CompletionContext;
}

describe('makeTagCompletionSource', () => {
  const source = makeTagCompletionSource(() => TAGS);

  it('offers prefix matches, most-used first, applying "#tag "', () => {
    const result = source(context({ from: 10, to: 13, text: '#sa' }));
    expect(result?.from).toBe(10);
    expect(result?.options.map((o) => o.label)).toEqual(['#sailing', '#sales']);
    expect(result?.options[0].apply).toBe('#sailing ');
    expect(result?.options[0].detail).toBe('9×');
  });

  it('returns null on a bare # unless completion was explicitly requested', () => {
    expect(source(context({ from: 5, to: 5, text: '#' }))).toBeNull();
    expect(source(context({ from: 5, to: 5, text: '#' }, true))?.options.length).toBe(2);
  });

  it('returns null when nothing matches or there is no # token', () => {
    expect(source(context({ from: 0, to: 4, text: '#zzz' }))).toBeNull();
    expect(source(context(null))).toBeNull();
  });
});
