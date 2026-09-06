import { deepEqual } from '../../../shared/deep-equal';

describe('deepEqual', () => {
  it('compares primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });

  it('ignores key order', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('compares nested objects and arrays structurally', () => {
    const a = { llm: { enabled: true, tags: ['x', 'y'] }, n: [{ k: 1 }] };
    const b = { llm: { enabled: true, tags: ['x', 'y'] }, n: [{ k: 1 }] };
    expect(deepEqual(a, b)).toBe(true);
    expect(deepEqual(a, { ...b, n: [{ k: 2 }] })).toBe(false);
  });

  it('distinguishes missing keys from undefined-valued ones by count', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  it('treats arrays of different length or type as unequal', () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });
});
