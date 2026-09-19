import { buildTextMatcher, replaceInRanges, runTagSearch } from './search';
import type { SearchableSection } from './search';

/**
 * The matcher flags (milestone 33): match-case, whole word, regex — plus
 * the range-limited replace used by the cross-file replace backend.
 */

const SECTIONS: SearchableSection[] = [
  { path: 'a.md', heading: 'Alpha', line: 1, tags: ['x'], text: 'Foo foo FOO barfoobar foobaz' },
  { path: 'b.md', heading: 'Beta', line: 5, tags: [], text: 'plain body only' },
];

describe('buildTextMatcher', () => {
  it('defaults to case-insensitive substring terms (historical behavior)', () => {
    const m = buildTextMatcher({ tags: [], text: 'foo' });
    expect(m.ok && m.matches(SECTIONS[0].text.toLowerCase())).toBe(true);
    const hits = runTagSearch(SECTIONS, { tags: [], text: 'FOO' });
    expect(hits.map((h) => h.path)).toEqual(['a.md']);
  });

  it('caseSensitive: true keeps the case', () => {
    const hits = runTagSearch(SECTIONS, { tags: [], text: 'Foo', match: { caseSensitive: true } });
    expect(hits).toHaveLength(1); // 'Foo foo FOO' all still contain 'Foo'
    const exact = runTagSearch(SECTIONS, { tags: [], text: 'FOOX', match: { caseSensitive: true } });
    expect(exact).toHaveLength(0);
  });

  it('wholeWord respects Unicode letter boundaries', () => {
    const hits = runTagSearch(SECTIONS, { tags: [], text: 'foo', match: { wholeWord: true } });
    expect(hits).toHaveLength(1); // a.md: standalone 'foo' occurrences exist
    const inside = runTagSearch(SECTIONS, { tags: [], text: 'barfoo', match: { wholeWord: true } });
    expect(inside).toHaveLength(0); // only as a substring inside barfoobar
  });

  it('regex mode treats the text as ONE pattern and reports compile errors', () => {
    const hits = runTagSearch(SECTIONS, { tags: [], text: 'f(o+) ', match: { regex: true } });
    expect(hits).toHaveLength(1);
    const bad = buildTextMatcher({ tags: [], text: 'f(o', match: { regex: true } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain('RegExp');
    }
    // A non-compiling query matches nothing instead of throwing.
    expect(runTagSearch(SECTIONS, { tags: [], text: 'f(o', match: { regex: true } })).toEqual([]);
  });

  it('empty text matches everything (the tag half decides)', () => {
    const m = buildTextMatcher({ tags: [], text: '   ' });
    expect(m.ok && m.matches('')).toBe(true);
  });
});

describe('runTagSearch with flags', () => {
  it('combines tags AND flagged text', () => {
    const hits = runTagSearch(SECTIONS, {
      tags: ['x'],
      text: 'FOO',
      match: { caseSensitive: true },
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].heading).toBe('Alpha');
  });
});

describe('replaceInRanges', () => {
  const lines = ['keep', 'foo says foo', 'bar', 'Foo stays'];

  it('replaces only inside the given ranges', () => {
    const r = replaceInRanges(lines, { tags: [], text: 'foo' }, 'X', [
      { start: 2, end: 3 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines).toEqual(['keep', 'foo says foo', 'bar', 'X stays']);
      expect(r.occurrences).toBe(1); // line 3 'Foo' — case-insensitive by default
    }
  });

  it('replaces every occurrence on a range line', () => {
    const r = replaceInRanges(lines, { tags: [], text: 'foo' }, 'X', [{ start: 2, end: 2 }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines[1]).toBe('X says X');
      expect(r.occurrences).toBe(2);
    }
  });

  it('wholeWord leaves substrings alone', () => {
    const r = replaceInRanges(['barfoobar foo'], { tags: [], text: 'foo' }, 'X', [
      { start: 1, end: 1 },
    ], );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines).toEqual(['barfoobar X']);
      expect(r.occurrences).toBe(1);
    }
  });

  it('regex mode replaces with the pattern (replacement refs work)', () => {
    const r = replaceInRanges(['aa bb aa'], { tags: [], text: '(a+)', match: { regex: true } }, '<$1>', [
      { start: 1, end: 1 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines).toEqual(['<aa> bb <aa>']);
      expect(r.occurrences).toBe(2);
    }
  });

  it('surfaces a regex compile error', () => {
    const r = replaceInRanges(lines, { tags: [], text: 'f(o', match: { regex: true } }, 'X', [
      { start: 1, end: 1 },
    ]);
    expect(r.ok).toBe(false);
  });

  it('empty ranges are a no-op with zero occurrences', () => {
    const r = replaceInRanges(lines, { tags: [], text: 'foo' }, 'X', []);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines).toEqual(lines);
      expect(r.occurrences).toBe(0);
    }
  });
});
