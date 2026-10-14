import {
  MAX_QUERY_TERMS,
  buildVaultContextBlock,
  compactContextLine,
  contextCitations,
  deriveVaultScope,
  isVaultContextPath,
  normalizeVaultScope,
  queryTerms,
  rankLexical,
  resolveTargetVaultIds,
} from './vault-context';
import type { LexicalHit, RetrievedSection } from './vault-context';

describe('isVaultContextPath', () => {
  it('admits ordinary vault notes', () => {
    expect(isVaultContextPath('daily/2026/09/2026-09-18.md')).toBe(true);
    expect(isVaultContextPath('notes/idea.md')).toBe(true);
    expect(isVaultContextPath('a.md')).toBe(true);
  });

  it('excludes the chat notes (they contain the literal question text)', () => {
    expect(isVaultContextPath('chats/2026/10/2026-10-09-was-trinke-ich-morgens.md')).toBe(false);
    expect(isVaultContextPath('chats/x.md')).toBe(false);
  });

  it('is exact-prefix, so sibling names stay in', () => {
    expect(isVaultContextPath('chatsarchive/a.md')).toBe(true);
    expect(isVaultContextPath('notes/chats/x.md')).toBe(true);
  });
});

describe('normalizeVaultScope', () => {
  it('keeps the active scopes and maps everything else to off', () => {
    expect(normalizeVaultScope('vault')).toBe('vault');
    expect(normalizeVaultScope('all')).toBe('all');
    expect(normalizeVaultScope('custom')).toBe('custom');
    expect(normalizeVaultScope('off')).toBe('off');
    expect(normalizeVaultScope(undefined)).toBe('off');
    expect(normalizeVaultScope('nonsense')).toBe('off');
    expect(normalizeVaultScope(42)).toBe('off');
  });
});

describe('resolveTargetVaultIds', () => {
  const vaults = [
    { id: 'va', active: false },
    { id: 'vb', active: true },
    { id: 'vc', active: false },
  ];

  it('all → every registered id; vault → the active one', () => {
    expect(resolveTargetVaultIds(vaults, 'all')).toEqual(['va', 'vb', 'vc']);
    expect(resolveTargetVaultIds(vaults, 'vault')).toEqual(['vb']);
  });

  it('custom intersects with the registry and dedupes — dead ids drop silently', () => {
    expect(resolveTargetVaultIds(vaults, 'custom', ['vc', 'va', 'vc', 'gone'])).toEqual(['va', 'vc']);
  });

  it('custom with no surviving id is empty (no active-vault fallback)', () => {
    expect(resolveTargetVaultIds(vaults, 'custom', ['gone'])).toEqual([]);
    expect(resolveTargetVaultIds(vaults, 'custom')).toEqual([]);
  });
});

describe('deriveVaultScope', () => {
  const vaults = [
    { id: 'va', active: false },
    { id: 'vb', active: true },
    { id: 'vc', active: false },
  ];

  it('none → off; exactly the active vault → vault; every id → all', () => {
    expect(deriveVaultScope([], vaults)).toEqual({ scope: 'off', vaultIds: [] });
    expect(deriveVaultScope(['vb'], vaults)).toEqual({ scope: 'vault', vaultIds: [] });
    expect(deriveVaultScope(['vc', 'va', 'vb'], vaults)).toEqual({ scope: 'all', vaultIds: [] });
  });

  it('any other subset → custom with the ids in registry order', () => {
    expect(deriveVaultScope(['vc', 'va'], vaults)).toEqual({ scope: 'custom', vaultIds: ['va', 'vc'] });
  });

  it('a checked id outside the registry is ignored', () => {
    expect(deriveVaultScope(['va', 'ghost'], vaults)).toEqual({ scope: 'custom', vaultIds: ['va'] });
  });
});

describe('context shaping', () => {
  const hits: RetrievedSection[] = [
    { vaultId: 'v', path: 'daily/a.md', heading: 'Motivation', line: 4, text: 'Antrieb text' },
    { vaultId: 'v', path: 'notes/b.md', heading: 'Laufen', line: 9, text: 'Langlauf text' },
  ];

  it('builds a numbered read-only block with paths and truncation marker', () => {
    const block = buildVaultContextBlock(hits);
    expect(block).toContain('VAULT CONTEXT');
    expect(block).toContain('[1] daily/a.md — Motivation (line 4)');
    expect(block).toContain('Antrieb text');
    expect(block).toContain('[2] notes/b.md — Laufen (line 9)');
    const long = buildVaultContextBlock([
      { ...hits[0], text: 'y'.repeat(2000) },
    ]);
    expect(long).toContain('…section truncated…');
  });

  it('empty hits → no block', () => {
    expect(buildVaultContextBlock([])).toBe('');
  });

  it('citations drop the text; the replay line stays one line', () => {
    const cites = contextCitations(hits);
    expect(cites).toEqual([
      { path: 'daily/a.md', heading: 'Motivation', line: 4 },
      { path: 'notes/b.md', heading: 'Laufen', line: 9 },
    ]);
    const line = compactContextLine(cites);
    expect(line).toBe(
      '[Vault context used for this answer: daily/a.md — Motivation; notes/b.md — Laufen]',
    );
    expect(compactContextLine([])).toBe('');
  });

  it('vault names disambiguate equal paths across vaults', () => {
    const crossVault: RetrievedSection[] = [
      { vaultId: 'v1', vault: 'Privat', path: 'daily/a.md', heading: 'Motivation', line: 4, text: 'x' },
      { vaultId: 'v2', vault: 'Git', path: 'daily/a.md', heading: 'Klon', line: 2, text: 'y' },
    ];
    const block = buildVaultContextBlock(crossVault);
    expect(block).toContain('[1] Privat · daily/a.md — Motivation (line 4)');
    expect(block).toContain('[2] Git · daily/a.md — Klon (line 2)');
    const cites = contextCitations(crossVault);
    expect(cites[0]).toMatchObject({ vault: 'Privat', path: 'daily/a.md' });
    expect(compactContextLine(cites)).toBe(
      '[Vault context used for this answer: Privat · daily/a.md — Motivation; Git · daily/a.md — Klon]',
    );
  });
});

describe('queryTerms', () => {
  it('keeps the words that carry the topic', () => {
    expect(queryTerms('Was weiß ich über Einstein?')).toEqual(['einstein']);
    expect(queryTerms('What do I know about the harbour fee?')).toEqual(['harbour', 'fee']);
  });

  it('lower-cases, splits at punctuation and keeps each word once', () => {
    expect(queryTerms('Mast-Legen: Mast, legen!')).toEqual(['mast', 'legen']);
    expect(queryTerms('#projekt/frontend 2026')).toEqual(['projekt', 'frontend', '2026']);
  });

  it('drops words under three characters and stops at the cap', () => {
    expect(queryTerms('ab cd ef')).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) => `wort${i}`).join(' ');
    expect(queryTerms(many)).toHaveLength(MAX_QUERY_TERMS);
  });
});

describe('rankLexical', () => {
  const hit = (path: string, line: number, heading = 'H'): LexicalHit => ({
    vaultId: 'v',
    path,
    heading,
    line,
    text: 'body',
  });

  it('puts the section with the rare word first', () => {
    const ranked = rankLexical(
      [
        { term: 'physik', hits: [hit('a.md', 1), hit('b.md', 1), hit('c.md', 1), hit('d.md', 1)] },
        { term: 'einstein', hits: [hit('d.md', 1)] },
      ],
      4,
    );
    expect(ranked[0].path).toBe('d.md');
    expect(ranked).toHaveLength(4);
  });

  it('prefers a section that carries several words over one that carries one', () => {
    const ranked = rankLexical(
      [
        { term: 'boot', hits: [hit('a.md', 1), hit('b.md', 5)] },
        { term: 'winter', hits: [hit('b.md', 5), hit('c.md', 1)] },
      ],
      4,
    );
    expect(ranked.map((h) => h.path)).toEqual(['b.md', 'a.md', 'c.md']);
  });

  it('counts a word in the heading more than one in the text', () => {
    const ranked = rankLexical(
      [{ term: 'einstein', hits: [hit('a.md', 1, 'Notes'), hit('b.md', 1, 'Albert Einstein')] }],
      4,
    );
    expect(ranked[0].path).toBe('b.md');
  });

  it('keeps sections of equal paths in different vaults apart and respects the limit', () => {
    const other = { ...hit('a.md', 1), vaultId: 'w' };
    const perTerm = [{ term: 'boot', hits: [other, hit('z.md', 1), hit('a.md', 1)] }];
    expect(rankLexical(perTerm, 3).map((h) => `${h.vaultId}:${h.path}`)).toEqual([
      'v:a.md',
      'v:z.md',
      'w:a.md',
    ]);
    expect(rankLexical(perTerm, 2)).toHaveLength(2);
    expect(rankLexical([], 4)).toEqual([]);
  });
});
