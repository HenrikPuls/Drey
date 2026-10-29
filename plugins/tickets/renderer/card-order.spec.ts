import { describe, expect, it } from 'vitest';
import { cardOrderTargets } from './card-order';

const COLUMN = ['T-0001', 'T-0002', 'T-0003'].map((id) => ({ id }));

describe('cardOrderTargets', () => {
  it('targets both ends for a middle card', () => {
    expect(cardOrderTargets(COLUMN, 'T-0002')).toEqual({ top: 0, bottom: 2 });
  });

  it('yields no top for the first card and no bottom for the last', () => {
    expect(cardOrderTargets(COLUMN, 'T-0001')).toEqual({ top: null, bottom: 2 });
    expect(cardOrderTargets(COLUMN, 'T-0003')).toEqual({ top: 0, bottom: null });
  });

  it('yields neither on a single-ticket column', () => {
    expect(cardOrderTargets([{ id: 'T-0007' }], 'T-0007')).toEqual({ top: null, bottom: null });
  });

  it('yields neither for an unknown id (a stale menu)', () => {
    expect(cardOrderTargets(COLUMN, 'T-0099')).toEqual({ top: null, bottom: null });
  });
});
