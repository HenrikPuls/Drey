import { fuzzyFilter, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('matches a subsequence case-insensitively and rejects a missing character', () => {
    expect(fuzzyScore('mtg', 'Meeting notes.md')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Meeting notes.md')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('ranks a contiguous word-start match above a scattered one', () => {
    const tight = fuzzyScore('plan', 'Plan 2026.md')!;
    const loose = fuzzyScore('plan', 'Purple anchor.md')!;
    expect(tight).toBeGreaterThan(loose);
  });

  it('rewards word starts and camelCase humps', () => {
    expect(fuzzyScore('sp', 'split-pane.md')!).toBeGreaterThan(fuzzyScore('sp', 'whisper.md')!);
    expect(fuzzyScore('ts', 'toggleSource')!).toBeGreaterThan(fuzzyScore('ts', 'tests')! - 12);
  });
});

describe('fuzzyFilter', () => {
  const score = (item: string, q: string): number | null => fuzzyScore(q, item);

  it('returns the incoming order for an empty query, capped', () => {
    expect(fuzzyFilter(['b', 'a', 'c'], ' ', score, 2)).toEqual(['b', 'a']);
  });

  it('sorts best first and keeps ties in incoming order', () => {
    expect(fuzzyFilter(['zzplanzz.md', 'plan.md', 'other.md'], 'plan', score, 10)).toEqual([
      'plan.md',
      'zzplanzz.md',
    ]);
    expect(fuzzyFilter(['ab', 'ab'], 'ab', score, 10)).toHaveLength(2);
  });
});
