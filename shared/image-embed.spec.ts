import {
  clampEmbedWidth,
  EMBED_WIDTH_MAX,
  EMBED_WIDTH_MIN,
  parseImageEmbed,
  setEmbedWidth,
} from './image-embed';

describe('parseImageEmbed', () => {
  it('returns the alt unchanged when there is no size suffix', () => {
    expect(parseImageEmbed('a boat')).toEqual({ alt: 'a boat', width: null, height: null });
    expect(parseImageEmbed('')).toEqual({ alt: '', width: null, height: null });
  });

  it('reads a trailing |<width>', () => {
    expect(parseImageEmbed('a boat|300')).toEqual({ alt: 'a boat', width: 300, height: null });
    expect(parseImageEmbed('|120')).toEqual({ alt: '', width: 120, height: null });
    expect(parseImageEmbed('shot| 250 ')).toEqual({ alt: 'shot', width: 250, height: null });
  });

  it('reads a trailing |<width>x<height>', () => {
    expect(parseImageEmbed('plan|300x200')).toEqual({ alt: 'plan', width: 300, height: 200 });
  });

  it('only treats the segment after the LAST bar as the size', () => {
    expect(parseImageEmbed('a | b')).toEqual({ alt: 'a | b', width: null, height: null });
    expect(parseImageEmbed('a|b|200')).toEqual({ alt: 'a|b', width: 200, height: null });
  });

  it('treats a zero / negative / non-integer token as ordinary alt text', () => {
    expect(parseImageEmbed('x|0')).toEqual({ alt: 'x|0', width: null, height: null });
    expect(parseImageEmbed('x|-5')).toEqual({ alt: 'x|-5', width: null, height: null });
    expect(parseImageEmbed('x|3.5')).toEqual({ alt: 'x|3.5', width: null, height: null });
    expect(parseImageEmbed('x|abc')).toEqual({ alt: 'x|abc', width: null, height: null });
    expect(parseImageEmbed('x|300x0')).toEqual({ alt: 'x|300x0', width: null, height: null });
  });
});

describe('clampEmbedWidth', () => {
  it('bounds and rounds', () => {
    expect(clampEmbedWidth(4)).toBe(EMBED_WIDTH_MIN);
    expect(clampEmbedWidth(999999)).toBe(EMBED_WIDTH_MAX);
    expect(clampEmbedWidth(287.6)).toBe(288);
    expect(clampEmbedWidth(Number.NaN)).toBe(EMBED_WIDTH_MIN);
  });
});

describe('setEmbedWidth', () => {
  it('appends |W when there is no suffix', () => {
    expect(setEmbedWidth('a boat', 320)).toBe('a boat|320');
    expect(setEmbedWidth('', 320)).toBe('|320');
  });

  it('replaces an existing |W', () => {
    expect(setEmbedWidth('a boat|300', 180)).toBe('a boat|180');
  });

  it('collapses an existing |WxH to width only', () => {
    expect(setEmbedWidth('plan|300x200', 260)).toBe('plan|260');
  });

  it('clamps and rounds and preserves interior bars in the alt', () => {
    expect(setEmbedWidth('a|b|200', 8)).toBe(`a|b|${EMBED_WIDTH_MIN}`);
    expect(setEmbedWidth('emoji 🚀 pic|100', 512.4)).toBe('emoji 🚀 pic|512');
  });
});
