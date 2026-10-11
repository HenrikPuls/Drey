import {
  DEFAULT_SEMANTIC_MODEL,
  DEFAULT_SEMANTIC_SEARCH_LIMIT,
  MAX_SEMANTIC_SEARCH_LIMIT,
  buildVaultContextBlock,
  compactContextLine,
  contextCitations,
  cosineSimilarity,
  decodeVector,
  deriveVaultScope,
  encodeVector,
  isSemanticIndexPath,
  normalizeVaultScope,
  passageText,
  queryText,
  resolveTargetVaultIds,
  semanticSectionsFor,
  semanticSnippet,
  splitSemanticSections,
} from './semantic';
import type { RetrievedSection } from './semantic';

describe('isSemanticIndexPath', () => {
  it('admits ordinary vault notes', () => {
    expect(isSemanticIndexPath('daily/2026/09/2026-09-18.md')).toBe(true);
    expect(isSemanticIndexPath('notes/idea.md')).toBe(true);
    expect(isSemanticIndexPath('a.md')).toBe(true);
  });

  it('excludes the chat notes (they embed the literal question text)', () => {
    expect(isSemanticIndexPath('chats/2026/10/2026-10-09-was-trinke-ich-morgens.md')).toBe(false);
    expect(isSemanticIndexPath('chats/x.md')).toBe(false);
  });

  it('is exact-prefix, so sibling names stay indexed', () => {
    expect(isSemanticIndexPath('chatsarchive/a.md')).toBe(true);
    expect(isSemanticIndexPath('notes/chats/x.md')).toBe(true);
  });
});

describe('normalizeVaultScope', () => {
  it('keeps the retrieval scopes and maps everything else to off', () => {
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

describe('e5 prefixes', () => {
  it('prefixes e5 models, leaves others bare', () => {
    expect(queryText('Xenova/multilingual-e5-small', ' motivation  ')).toBe('query: motivation');
    expect(passageText('Xenova/multilingual-e5-small', 'body')).toBe('passage: body');
    expect(queryText('some-other-model', 'motivation')).toBe('motivation');
    expect(passageText('some-other-model', 'body')).toBe('body');
  });

  it('caps passages at 2000 chars AFTER prefixing decision', () => {
    const long = 'x'.repeat(3000);
    const prefixed = passageText(DEFAULT_SEMANTIC_MODEL, long);
    expect(prefixed.startsWith('passage: ')).toBe(true);
    expect(prefixed.length).toBe('passage: '.length + 2000);
  });
});

describe('splitSemanticSections', () => {
  it('splits at headings of any level and keeps the pre-heading part', () => {
    const sections = splitSemanticSections('Intro line\n# One\nbody one\n## Two\nbody two\n');
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({ heading: '', level: 0, line: 1, text: 'Intro line' });
    expect(sections[1]).toMatchObject({ heading: 'One', level: 1, line: 2, text: 'body one' });
    expect(sections[2]).toMatchObject({ heading: 'Two', level: 2, line: 4, text: 'body two' });
  });

  it('ignores # inside fenced code blocks', () => {
    const sections = splitSemanticSections('# Real\n```md\n# Not a heading\n```\nafter');
    expect(sections).toHaveLength(1);
    expect(sections[0].text).toContain('# Not a heading');
  });

  it('drops an empty pre-heading section but keeps empty heading sections', () => {
    const sections = splitSemanticSections('\n\n# Empty\n');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ heading: 'Empty', text: '' });
  });
});

describe('semanticSectionsFor', () => {
  it('falls back to the file base name and skips empty bodies', () => {
    const sections = semanticSectionsFor('daily/2026-09-24.md', '# Morning\nrun 5k\n');
    expect(sections).toEqual([{ heading: 'Morning', line: 1, text: 'run 5k' }]);
    const untitled = semanticSectionsFor('notes/idea.md', 'just a line');
    expect(untitled[0].heading).toBe('idea.md');
    expect(semanticSectionsFor('empty.md', '# Empty\n\n')).toHaveLength(0);
  });
});

describe('vector roundtrip + cosine', () => {
  it('survives encode/decode exactly', () => {
    const vector = Float32Array.from([0.25, -0.5, 1, 0, -1.75]);
    const decoded = decodeVector(encodeVector(vector));
    expect(Array.from(decoded)).toEqual(Array.from(vector));
  });

  it('cosine ranks identical highest and orthogonal zero', () => {
    const a = Float32Array.from([1, 0, 2]);
    expect(cosineSimilarity(a, Float32Array.from([2, 0, 4]))).toBeCloseTo(1);
    expect(cosineSimilarity(a, Float32Array.from([0, 5, 0]))).toBeCloseTo(0);
    expect(cosineSimilarity(a, Float32Array.from([-1, 0, -2]))).toBeCloseTo(-1);
    expect(cosineSimilarity(new Float32Array(0), new Float32Array(0))).toBe(0);
  });
});

describe('context shaping', () => {
  const hits: RetrievedSection[] = [
    { vaultId: 'v', path: 'daily/a.md', heading: 'Motivation', line: 4, score: 0.86, text: 'Antrieb text' },
    { vaultId: 'v', path: 'notes/b.md', heading: 'Laufen', line: 9, score: 0.71, text: 'Langlauf text' },
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

  it('citations drop score and text; the replay line stays one line', () => {
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
      { vaultId: 'v1', vault: 'Privat', path: 'daily/a.md', heading: 'Motivation', line: 4, score: 0.9, text: 'x' },
      { vaultId: 'v2', vault: 'Git', path: 'daily/a.md', heading: 'Klon', line: 2, score: 0.8, text: 'y' },
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

describe('the SDK search seam budget (1.18)', () => {
  it('defaults above an ask turn\'s topK and caps at 20', () => {
    expect(DEFAULT_SEMANTIC_SEARCH_LIMIT).toBeGreaterThan(4);
    expect(MAX_SEMANTIC_SEARCH_LIMIT).toBe(20);
  });
});

describe('semanticSnippet', () => {
  it('collapses whitespace and shortens with an ellipsis', () => {
    expect(semanticSnippet('Kaffee   trinken\n\nmorgens')).toBe('Kaffee trinken morgens');
    const long = semanticSnippet(`${'a'.repeat(300)}`);
    expect(long.length).toBe(241); // 240 chars + the ellipsis
    expect(long.endsWith('…')).toBe(true);
    expect(semanticSnippet('  kurz  ')).toBe('kurz');
  });
});
