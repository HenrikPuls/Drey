import { describe, expect, it } from 'vitest';
import { changesOf } from './scroll-debug';

describe('changesOf (D-5b debug recorder)', () => {
  const base = { values: { scrollY: 0, 'vv.offsetTop': 0, '.hdr.top': 0, 'vv.scale': 1 } };

  it('reports nothing while nothing moved', () => {
    expect(changesOf(base, { values: { ...base.values } })).toEqual([]);
  });

  it('names every value that moved, however little', () => {
    const now = { values: { scrollY: 3, 'vv.offsetTop': 0, '.hdr.top': -2.5, 'vv.scale': 1.07 } };
    expect(changesOf(base, now)).toEqual(['scrollY 0 → 3', '.hdr.top 0 → -2.5', 'vv.scale 1 → 1.07']);
  });

  it('ignores rounding noise and values that were not sampled before', () => {
    expect(changesOf(base, { values: { ...base.values, scrollY: 0.004, '.composer.top': 700 } })).toEqual([]);
  });
});
