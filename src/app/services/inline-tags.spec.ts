import { extractInlineTags } from '../../../shared/inline-tags';

describe('extractInlineTags', () => {
  it('pulls lower-cased tags in order, de-duplicated', () => {
    expect(
      extractInlineTags('Zweite Besichtigung #Sailing, neuer Kandidat #sailing #Kiel'),
    ).toEqual(['sailing', 'kiel']);
  });

  it('ignores timestamp headings and task/important markers', () => {
    const body = '## 14:32\n### 2026-09-05 14:32\n- [ ] Kiel prüfen #task #important #sailing\n';
    expect(extractInlineTags(body)).toEqual(['sailing']);
  });

  it('skips tags inside fenced and inline code', () => {
    const body = 'text #real\n```\n#nope\n```\nmore `#alsonope` end #second';
    expect(extractInlineTags(body)).toEqual(['real', 'second']);
  });

  it('requires a letter as the first character', () => {
    expect(extractInlineTags('#2fa and #-dash but #ok2')).toEqual(['ok2']);
  });

  it('returns an empty array when there are no tags', () => {
    expect(extractInlineTags('plain text, no hashes')).toEqual([]);
  });
});
