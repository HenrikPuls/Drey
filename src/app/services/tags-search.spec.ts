import { formatSearchResultsDoc, runTagSearch, SearchableSection } from '../../../shared/tags';

const SECTIONS: SearchableSection[] = [
  {
    path: 'daily/2026/09/2026-09-06.md',
    heading: '08:00 — Kielboot',
    line: 4,
    tags: ['sailing', 'kauf'],
    text: 'Zweite Besichtigung fiel aus. Preisverhandlung offen. #sailing #kauf',
  },
  {
    path: 'daily/2026/09/2026-09-07.md',
    heading: '09:30',
    line: 4,
    tags: ['sailing'],
    text: 'Neuer Kandidat in Kiel, Termin steht. #sailing',
  },
  {
    path: 'notes/finanzen.md',
    heading: 'Budget',
    line: 1,
    tags: ['kauf'],
    text: 'Obergrenze 45k egal in welchem Zustand. #kauf',
  },
];

describe('runTagSearch', () => {
  it('returns nothing for an empty query', () => {
    expect(runTagSearch(SECTIONS, { tags: [], text: '' })).toEqual([]);
  });

  it('ANDs multiple tags', () => {
    const hits = runTagSearch(SECTIONS, { tags: ['sailing', 'kauf'], text: '' });
    expect(hits.map((h) => h.path)).toEqual(['daily/2026/09/2026-09-06.md']);
    expect(hits[0]).toMatchObject({ heading: '08:00 — Kielboot', line: 4 });
  });

  it('a single tag returns every section carrying it, path then line', () => {
    const hits = runTagSearch(SECTIONS, { tags: ['sailing'], text: '' });
    expect(hits.map((h) => h.path)).toEqual([
      'daily/2026/09/2026-09-06.md',
      'daily/2026/09/2026-09-07.md',
    ]);
  });

  it('free text alone matches body or heading, all terms required', () => {
    expect(runTagSearch(SECTIONS, { tags: [], text: 'kiel termin' }).map((h) => h.path)).toEqual([
      'daily/2026/09/2026-09-07.md',
    ]);
    // "Budget" is only in the heading -- still a hit.
    expect(runTagSearch(SECTIONS, { tags: [], text: 'budget' }).map((h) => h.path)).toEqual([
      'notes/finanzen.md',
    ]);
  });

  it('combines tags and free text', () => {
    expect(
      runTagSearch(SECTIONS, { tags: ['kauf'], text: 'obergrenze' }).map((h) => h.path),
    ).toEqual(['notes/finanzen.md']);
  });

  it('builds a snippet around the first match and carries the full section text', () => {
    const [hit] = runTagSearch(SECTIONS, { tags: [], text: 'preisverhandlung' });
    expect(hit.snippet).toContain('Preisverhandlung offen');
    expect(hit.text).toBe(SECTIONS[0].text);
  });
});

describe('formatSearchResultsDoc', () => {
  it('lists each hit as `## <path>:<line>` + full section text under a query header', () => {
    const hits = runTagSearch(SECTIONS, { tags: ['sailing', 'kauf'], text: '' });
    const doc = formatSearchResultsDoc({ tags: ['sailing', 'kauf'], text: '' }, hits);
    expect(doc).toBe(
      '# Search results\n\n' +
        '#sailing #kauf — 1 section\n\n' +
        '## daily/2026/09/2026-09-06.md:4\n\n' +
        'Zweite Besichtigung fiel aus. Preisverhandlung offen. #sailing #kauf\n',
    );
  });

  it('folds free text into the header', () => {
    const doc = formatSearchResultsDoc({ tags: [], text: 'kiel  termin' }, []);
    expect(doc.split('\n')[2]).toBe('"kiel  termin" — 0 sections');
  });
});
