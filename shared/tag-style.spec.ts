import { TAG_AUTO_PALETTE, normalizeTagPrefix, resolveTagStyle, tagChipColors } from './tag-style';

describe('normalizeTagPrefix', () => {
  it('trims, lower-cases and strips # and trailing slashes', () => {
    expect(normalizeTagPrefix(' Proj/ ')).toBe('proj');
    expect(normalizeTagPrefix('#Status/')).toBe('status');
    expect(normalizeTagPrefix('Proj/Frontend//')).toBe('proj/frontend');
  });

  it('rejects empty or grammar-invalid prefixes', () => {
    expect(normalizeTagPrefix('')).toBeNull();
    expect(normalizeTagPrefix('   ')).toBeNull();
    expect(normalizeTagPrefix('#/')).toBeNull();
    expect(normalizeTagPrefix('42start')).toBeNull();
    expect(normalizeTagPrefix('a//b')).toBeNull();
  });
});

describe('resolveTagStyle', () => {
  const prefixes = [
    { prefix: 'proj', color: '#ff0000' },
    { prefix: 'proj/frontend', color: '#00ff00' },
  ];

  it('the longest matching configured prefix wins', () => {
    expect(resolveTagStyle('proj/frontend/nav', prefixes)).toEqual({
      color: '#00ff00',
      origin: 'configured',
    });
    expect(resolveTagStyle('proj/backend', prefixes)).toEqual({
      color: '#ff0000',
      origin: 'configured',
    });
  });

  it('matches a prefix only at a / boundary, not by string start', () => {
    expect(resolveTagStyle('projection', prefixes).origin).toBe('auto');
  });

  it('falls back to a stable palette color keyed on the first segment', () => {
    const first = resolveTagStyle('xyz/alpha', []);
    const second = resolveTagStyle('xyz/beta', []);
    const expected = TAG_AUTO_PALETTE.indexOf(first.color);
    expect(expected).toBeGreaterThanOrEqual(0);
    expect(second.color).toBe(first.color);
    expect(first.origin).toBe('auto');
  });

  it('bare tags hash themselves but stay deterministic', () => {
    expect(resolveTagStyle('sailing', [])).toEqual(resolveTagStyle('sailing', []));
    expect(TAG_AUTO_PALETTE).toContain(resolveTagStyle('sailing', []).color);
  });
});

describe('tagChipColors', () => {
  it('mirrors the accent token mixes for foreground and fill', () => {
    expect(tagChipColors('#c96442')).toEqual({
      fg: 'color-mix(in srgb, #c96442 58%, #f2efe9)',
      bg: 'color-mix(in srgb, #c96442 15%, transparent)',
    });
  });
});
