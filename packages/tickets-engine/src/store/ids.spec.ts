import { describe, expect, it } from 'vitest';

import { isDisplayId, toDisplayId, toDricketId } from './ids';

describe('id mapping (OD-1)', () => {
  it('maps display ids to dricket ids and back, numbers preserved', () => {
    expect(toDricketId('T-0063')).toBe('t-63');
    expect(toDricketId('T-0001')).toBe('t-1');
    expect(toDricketId('T-10000')).toBe('t-10000');
    expect(toDisplayId('t-63')).toBe('T-0063');
    expect(toDisplayId('t-1')).toBe('T-0001');
    expect(toDisplayId('t-10000')).toBe('T-10000');
  });

  it('round-trips', () => {
    for (const id of ['T-0001', 'T-0063', 'T-0999', 'T-12345']) {
      expect(toDisplayId(toDricketId(id)!)).toBe(id);
    }
  });

  it('refuses what is not a display id', () => {
    expect(toDricketId('t-63')).toBeNull();
    expect(toDricketId('T-0000')).toBeNull();
    expect(toDricketId('T-')).toBeNull();
    expect(toDricketId('')).toBeNull();
    expect(isDisplayId('T-0063')).toBe(true);
    expect(isDisplayId('x-5')).toBe(false);
  });

  it('lets a foreign prefix pass through visibly (lower case)', () => {
    expect(toDisplayId('x-5')).toBe('x-5');
    expect(toDisplayId('t-0')).toBe('t-0');
  });
});
