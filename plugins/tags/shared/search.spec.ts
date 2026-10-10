import {
  buildSearchSummaryMaterial,
  buildSearchSummarySources,
  buildTextMatcher,
  describeSearchQuery,
  filterChatHits,
  formatSearchResultsDoc,
  isChatNotePath,
  formatSearchSummaryHeader,
  replaceInRanges,
  runTagSearch,
} from './search';
import type { SearchableSection, TagSearchHit } from './search';

/**
 * The matcher flags (milestone 33): match-case, whole word, regex — plus
 * the range-limited replace used by the cross-file replace backend.
 */

const SECTIONS: SearchableSection[] = [
  { path: 'a.md', heading: 'Alpha', line: 1, tags: ['x'], text: 'Foo foo FOO barfoobar foobaz' },
  { path: 'b.md', heading: 'Beta', line: 5, tags: [], text: 'plain body only' },
];

describe('filterChatHits — the panel\'s "Include chats" toggle', () => {
  const HITS = [
    { path: 'chats/2026/10/frage.md' },
    { path: 'daily/2026/10/2026-10-10.md' },
    { path: 'notes/chats/not-a-chat.md' },
    { path: 'chatsworth.md' },
  ];

  it('drops chat notes unless they were asked for', () => {
    expect(filterChatHits(HITS, false).map((h) => h.path)).toEqual([
      'daily/2026/10/2026-10-10.md',
      'notes/chats/not-a-chat.md',
      'chatsworth.md',
    ]);
    expect(filterChatHits(HITS, true)).toEqual(HITS);
  });

  it('only the vault-root chats/ folder counts', () => {
    expect(isChatNotePath('chats/a.md')).toBe(true);
    expect(isChatNotePath('chats')).toBe(true);
    expect(isChatNotePath('archive/chats/a.md')).toBe(false);
  });
});

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
      expect(bad.error.toLowerCase()).toContain('regular expression');
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

  it('replaces only inside the given ranges (1-based, inclusive)', () => {
    const r = replaceInRanges(lines, { tags: [], text: 'foo' }, 'X', [
      { start: 2, end: 3 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Lines 2–3 are in range: 'foo says foo' is replaced, 'bar' has no
      // match, line 4 ('Foo stays') is out of range and untouched.
      expect(r.lines).toEqual(['keep', 'X says X', 'bar', 'Foo stays']);
      expect(r.occurrences).toBe(2);
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

  it('wholeWord leaves substrings alone (flag required)', () => {
    const r = replaceInRanges(['barfoobar foo'], { tags: [], text: 'foo', match: { wholeWord: true } }, 'X', [
      { start: 1, end: 1 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines).toEqual(['barfoobar X']);
      expect(r.occurrences).toBe(1);
    }
    // Without the flag the historical substring default applies.
    const plain = replaceInRanges(['barfoobar foo'], { tags: [], text: 'foo' }, 'X', [
      { start: 1, end: 1 },
    ]);
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.lines).toEqual(['barXbar X']);
    }
  });

  it('regex mode replaces literally (no $1 refs)', () => {
    const r = replaceInRanges(['aa bb aa'], { tags: [], text: '(a+)', match: { regex: true } }, '<X>', [
      { start: 1, end: 1 },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines).toEqual(['<X> bb <X>']);
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

describe('buildSearchSummaryMaterial', () => {
  const hit = (path: string, text: string, vaultId?: string): TagSearchHit => ({
    path,
    heading: `Head ${path}`,
    line: 1,
    snippet: '',
    text,
    ...(vaultId !== undefined ? { vaultId } : {}),
  });

  it('labels each section with path, line and heading', () => {
    const material = buildSearchSummaryMaterial({ tags: [], text: 'foo' }, [hit('a.md', 'body')]);
    expect(material.message).toContain('### a.md:1 — Head a.md');
    expect(material.message).toContain('body');
    expect(material.included).toBe(1);
    expect(material.total).toBe(1);
  });

  it('describes the query (tags AND text, trimmed)', () => {
    const material = buildSearchSummaryMaterial({ tags: ['x', 'y'], text: ' foo bar ' }, [
      hit('a.md', 'body'),
    ]);
    expect(material.message).toContain('Search query: #x + #y · "foo bar"');
    expect(describeSearchQuery({ tags: [], text: '   ' })).toBe('(everything)');
  });

  it('prefixes the vault id when the hits span several vaults', () => {
    const material = buildSearchSummaryMaterial({ tags: [], text: '' }, [
      hit('a.md', 'one', 'v1'),
      hit('b.md', 'two', 'v2'),
    ]);
    expect(material.message).toContain('### v1/a.md:1');
    expect(material.message).toContain('### v2/b.md:1');
  });

  it('cuts at a whole-section boundary and reports the truncation', () => {
    // Each block costs ~75 chars (label + text); a 200 budget fits two.
    const material = buildSearchSummaryMaterial(
      { tags: [], text: '' },
      [hit('a.md', 'x'.repeat(50)), hit('b.md', 'y'.repeat(50)), hit('c.md', 'z'.repeat(50))],
      200,
    );
    expect(material.included).toBe(2);
    expect(material.total).toBe(3);
    expect(material.message).toContain('Sections: 2 of 3');
    expect(material.message).not.toContain('zzzzz');
  });

  it('always includes the first section, however large', () => {
    const material = buildSearchSummaryMaterial({ tags: [], text: '' }, [hit('a.md', 'x'.repeat(500))], 10);
    expect(material.included).toBe(1);
    expect(material.total).toBe(1);
    expect(material.message).toContain('Sections: 1');
  });
});

describe('formatSearchSummaryHeader', () => {
  it('carries title, query, section count, timestamp and the digest rule', () => {
    const header = formatSearchSummaryHeader({ tags: ['x'], text: 'foo' }, 12, '2026-09-20 18:42');
    expect(header).toContain('# Search summary');
    expect(header).toContain('Query: #x · "foo"');
    expect(header).toContain('Generated from 12 search sections on 2026-09-20 18:42');
    expect(header).toContain('---');
  });

  it('uses the singular for one section', () => {
    const header = formatSearchSummaryHeader({ tags: [], text: '' }, 1, 't');
    expect(header).toContain('Generated from 1 search section on t');
  });
});

describe('buildSearchSummarySources', () => {
  const hit = (path: string, heading: string, line: number, vaultId?: string): TagSearchHit => ({
    path,
    heading,
    line,
    snippet: '',
    text: 'body',
    ...(vaultId !== undefined ? { vaultId } : {}),
  });

  it('links each included hit with an extension-less path and a heading anchor', () => {
    const sources = buildSearchSummarySources(
      [hit('daily/journal.md', 'Standup', 12), hit('notes/plan.md', 'Next steps', 40)],
      2,
    );
    expect(sources).toContain('## Sources');
    expect(sources).toContain('- [[daily/journal#Standup]] — daily/journal.md:12');
    expect(sources).toContain('- [[notes/plan#Next steps]] — notes/plan.md:40');
  });

  it('omits the anchor for heading-less sections and keeps non-.md extensions', () => {
    const sources = buildSearchSummarySources(
      [hit('notes/intro.md', '', 1), hit('pad/note.markdown', 'Log', 3)],
      2,
    );
    expect(sources).toContain('- [[notes/intro]] — notes/intro.md:1');
    expect(sources).toContain('- [[pad/note.markdown#Log]] — pad/note.markdown:3');
  });

  it('drops the anchor when the heading would break the wikilink syntax', () => {
    const sources = buildSearchSummarySources([hit('a.md', 'See [refs] | done', 7)], 1);
    expect(sources).toContain('- [[a]] — a.md:7');
  });

  it('keeps only the included prefix (same cut as the material) and tolerates over-given counts', () => {
    const hits = [hit('a.md', 'A', 1), hit('b.md', 'B', 2), hit('c.md', 'C', 3)];
    expect(buildSearchSummarySources(hits, 2)).not.toContain('c.md');
    const all = buildSearchSummarySources(hits, 99).split('\n').filter((l) => l.startsWith('- '));
    expect(all).toHaveLength(3);
    expect(buildSearchSummarySources(hits, 0)).toBe('');
  });

  it('labels the vault name only when the hits span several vaults', () => {
    const multi = buildSearchSummarySources(
      [hit('a.md', 'A', 1, 'v1'), hit('b.md', 'B', 2, 'v2')],
      2,
      { v1: 'Work', v2: 'Private' },
    );
    expect(multi).toContain('- [[a#A]] — Work · a.md:1');
    expect(multi).toContain('- [[b#B]] — Private · b.md:2');

    const single = buildSearchSummarySources([hit('a.md', 'A', 1, 'v1')], 1, { v1: 'Work' });
    expect(single).toContain('- [[a#A]] — a.md:1');
  });

  it('normalises backslash separators', () => {
    const sources = buildSearchSummarySources([hit('daily\\win.md', 'Tag', 4)], 1);
    expect(sources).toContain('- [[daily/win#Tag]] — daily/win.md:4');
  });
});
