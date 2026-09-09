import { extractInlineTags, extractTagOccurrences, splitSections } from '../../../shared/tags';

describe('extractInlineTags', () => {
  it('pulls lower-cased tags in order, de-duplicated', () => {
    expect(
      extractInlineTags('Zweite Besichtigung #Sailing, neuer Kandidat #sailing #Kiel'),
    ).toEqual(['sailing', 'kiel']);
  });

  it('keeps #important (now an ordinary tag) but never #task', () => {
    const body = '## 14:32\n### 2026-09-05 14:32\n- [ ] Kiel prüfen #task #important #sailing\n';
    expect(extractInlineTags(body)).toEqual(['important', 'sailing']);
  });

  it('skips tags inside fenced and inline code', () => {
    const body = 'text #real\n```\n#nope\n```\nmore `#alsonope` end #second';
    expect(extractInlineTags(body)).toEqual(['real', 'second']);
  });

  it('requires a letter as the first character', () => {
    expect(extractInlineTags('#2fa and #-dash but #ok2')).toEqual(['ok2']);
  });

  it('keeps nested tags whole; the first segment must start with a letter', () => {
    expect(
      extractInlineTags('#project/frontend #project/frontend/api #q3/2024 but not #2024/01'),
    ).toEqual(['project/frontend', 'project/frontend/api', 'q3/2024']);
  });

  it('does not eat a trailing slash into the tag', () => {
    expect(extractInlineTags('done #project/ and #plain/')).toEqual(['project', 'plain']);
  });

  it('reserves the whole #task/* subtree, not just #task', () => {
    expect(extractInlineTags('#task #task/blocked #tasky/x')).toEqual(['tasky/x']);
  });

  it('returns an empty array when there are no tags', () => {
    expect(extractInlineTags('plain text, no hashes')).toEqual([]);
  });
});

describe('extractTagOccurrences', () => {
  it('reports each occurrence with the offset of its "#"', () => {
    const body = 'a #one b #two #one';
    expect(extractTagOccurrences(body)).toEqual([
      { tag: 'one', index: 2 },
      { tag: 'two', index: 9 },
      { tag: 'one', index: 14 },
    ]);
    expect(body.slice(2, 6)).toBe('#one');
  });
});

describe('splitSections', () => {
  it('splits on headings of any level and drops an empty pre-heading part', () => {
    const body = '# Title\nintro\n\n## 08:00\nfirst\n\n### note\ndeep';
    expect(splitSections(body)).toEqual([
      { heading: 'Title', level: 1, line: 1, text: 'intro' },
      { heading: '08:00', level: 2, line: 4, text: 'first' },
      { heading: 'note', level: 3, line: 7, text: 'deep' },
    ]);
  });

  it('keeps content before the first heading as an implicit section', () => {
    expect(splitSections('loose #tag line\n\n## Later\nx')).toEqual([
      { heading: '', level: 0, line: 1, text: 'loose #tag line' },
      { heading: 'Later', level: 2, line: 3, text: 'x' },
    ]);
  });

  it('treats a heading-free body as one implicit section', () => {
    expect(splitSections('just prose #here')).toEqual([
      { heading: '', level: 0, line: 1, text: 'just prose #here' },
    ]);
  });

  it('does not split on a "#" inside a fenced code block', () => {
    const body = '## Real\n```\n# not a heading\n```\ntail';
    expect(splitSections(body)).toEqual([
      { heading: 'Real', level: 2, line: 1, text: '```\n# not a heading\n```\ntail' },
    ]);
  });
});
