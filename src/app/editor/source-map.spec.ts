import MarkdownIt from 'markdown-it';
import {
  alignRenderedToSource,
  blockIndexForSourceOffset,
  blockIndexOfClassName,
  renderWithSourceMap,
  sourceToRenderedOffset,
} from './source-map';

describe('alignRenderedToSource', () => {
  it('is the identity map for plain text', () => {
    const r2s = alignRenderedToSource('hello world', 'hello world');
    expect(r2s[0]).toBe(0);
    expect(r2s[6]).toBe(6);
    expect(r2s[11]).toBe(11);
  });

  it('is the identity map for verbatim (fenced-code) content', () => {
    const code = 'const x = 1;\nconst y = 2;\n';
    const r2s = alignRenderedToSource(code, code);
    for (let i = 0; i <= code.length; i++) {
      expect(r2s[i]).toBe(i);
    }
  });

  it('skips emphasis markers so the caret lands on the right source char', () => {
    // src:  a=0 ' '=1 *=2 *=3 b=4 o=5 l=6 d=7 *=8 *=9 ' '=10 c=11
    const src = 'a **bold** c';
    const r2s = alignRenderedToSource(src, 'a bold c');
    expect(r2s[2]).toBe(4); // rendered 'b' -> source index 4
    expect(r2s[5]).toBe(7); // rendered 'd' -> source index 7
    expect(src[r2s[7]]).toBe('c');
  });

  it('carries link text past the URL tail', () => {
    // src: g0 o1 ' '2 [3 h4 e5 r6 e7 ]8 (9 ... )18 ' '19 n20 o21 w22
    const src = 'go [here](http://x) now';
    const r2s = alignRenderedToSource(src, 'go here now');
    expect(src[r2s[3]]).toBe('h'); // start of visible link text
    expect(src[r2s[8]]).toBe('n'); // 'now', after the skipped (url)
  });
});

describe('sourceToRenderedOffset', () => {
  it('inverts the alignment', () => {
    const src = 'a **bold** c';
    const r2s = alignRenderedToSource(src, 'a bold c');
    expect(sourceToRenderedOffset(r2s, 0)).toBe(0);
    expect(sourceToRenderedOffset(r2s, 4)).toBe(2); // source 'b' -> rendered 2
    expect(sourceToRenderedOffset(r2s, 7)).toBe(5); // source 'd' -> rendered 5
  });
});

describe('renderWithSourceMap', () => {
  const md = new MarkdownIt({ html: false, linkify: true });

  it('marks block elements with a cm-src class and spans back into the source', () => {
    const src = '# Title\n\nA paragraph here.\n';
    const { html, spans } = renderWithSourceMap(md, src);

    expect(html).toContain('cm-src-0');
    expect(html).toContain('cm-src-1');
    expect(src.slice(spans[0].start, spans[0].end)).toBe('# Title');
    expect(src.slice(spans[1].start, spans[1].end)).toBe('A paragraph here.');
  });

  it('keeps markdown-it own classes alongside the marker (fenced code)', () => {
    const { html } = renderWithSourceMap(md, '```js\nconst x = 1;\n```\n');
    expect(html).toContain('language-js');
    expect(html).toMatch(/class="[^"]*cm-src-\d/);
  });

  it('tags nested blocks too (blockquote and its paragraph)', () => {
    const { html, spans } = renderWithSourceMap(md, '> quoted line\n');
    expect(html).toContain('<blockquote');
    expect(spans.length).toBeGreaterThanOrEqual(2);
  });
});

describe('blockIndexOfClassName', () => {
  it('parses the marker index out of a class list', () => {
    expect(blockIndexOfClassName('language-js cm-src-7')).toBe(7);
    expect(blockIndexOfClassName('cm-src-0')).toBe(0);
  });

  it('returns null when there is no marker', () => {
    expect(blockIndexOfClassName('language-js hljs')).toBeNull();
    expect(blockIndexOfClassName('')).toBeNull();
  });
});

describe('blockIndexForSourceOffset', () => {
  const spans = [
    { start: 0, end: 7 }, // heading
    { start: 9, end: 26 }, // paragraph
  ];

  it('returns the block that contains the offset', () => {
    expect(blockIndexForSourceOffset(spans, 3)).toBe(0);
    expect(blockIndexForSourceOffset(spans, 15)).toBe(1);
  });

  it('falls back to the last block starting before an in-between offset', () => {
    expect(blockIndexForSourceOffset(spans, 8)).toBe(0);
  });

  it('prefers the tightest span when blocks are nested', () => {
    const nested = [
      { start: 0, end: 40 }, // blockquote
      { start: 2, end: 20 }, // its paragraph
    ];
    expect(blockIndexForSourceOffset(nested, 10)).toBe(1);
  });

  it('returns null when there are no spans', () => {
    expect(blockIndexForSourceOffset([], 0)).toBeNull();
  });
});
