import { describe, expect, it } from 'vitest';
import { isNewerVersion, isVersionSkipped, parseVersion } from './updates';

describe('parseVersion', () => {
  it('parses plain release versions', () => {
    expect(parseVersion('0.6.0')).toEqual([0, 6, 0]);
    expect(parseVersion('1.20.3')).toEqual([1, 20, 3]);
  });

  it('tolerates a leading v and surrounding blanks', () => {
    expect(parseVersion(' v0.7.1 ')).toEqual([0, 7, 1]);
  });

  it('rejects anything not x.y.z', () => {
    expect(parseVersion('0.7')).toBeNull();
    expect(parseVersion('0.7.1-beta')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('orders by major, minor, patch', () => {
    expect(isNewerVersion('0.6.0', '0.6.1')).toBe(true);
    expect(isNewerVersion('0.6.0', '0.7.0')).toBe(true);
    expect(isNewerVersion('0.6.0', '1.0.0')).toBe(true);
    expect(isNewerVersion('0.6.0', '0.6.0')).toBe(false);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(false);
  });

  it('compares numerically, not lexically', () => {
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(true);
  });

  it('never reports a malformed candidate as newer', () => {
    expect(isNewerVersion('0.6.0', 'nope')).toBe(false);
    expect(isNewerVersion('nope', '0.7.0')).toBe(false);
  });
});

describe('isVersionSkipped', () => {
  it('is silent for exactly the skipped version', () => {
    expect(isVersionSkipped('0.7.0', '0.7.0')).toBe(true);
  });

  it('asks again for any other version', () => {
    expect(isVersionSkipped('0.7.1', '0.7.0')).toBe(false);
    expect(isVersionSkipped('0.7.0', null)).toBe(false);
  });
});
