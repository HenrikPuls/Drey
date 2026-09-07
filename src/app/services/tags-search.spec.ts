import { runTagSearch, SearchableSection } from '../../../shared/tags';

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

  it('builds a snippet around the first match', () => {
    const [hit] = runTagSearch(SECTIONS, { tags: [], text: 'preisverhandlung' });
    expect(hit.snippet).toContain('Preisverhandlung offen');
  });
});
