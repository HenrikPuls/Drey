import {
  DEFAULT_SEMANTIC_MODEL,
  buildVaultContextBlock,
  compactContextLine,
  contextCitations,
  cosineSimilarity,
  decodeVector,
  encodeVector,
  normalizeVaultScope,
  passageText,
  queryText,
  semanticSectionsFor,
  splitSemanticSections,
} from './semantic';
import type { RetrievedSection } from './semantic';

describe('normalizeVaultScope', () => {
  it('keeps the two retrieval scopes and maps everything else to off', () => {
    expect(normalizeVaultScope('vault')).toBe('vault');
    expect(normalizeVaultScope('all')).toBe('all');
    expect(normalizeVaultScope('off')).toBe('off');
    expect(normalizeVaultScope(undefined)).toBe('off');
    expect(normalizeVaultScope('nonsense')).toBe('off');
    expect(normalizeVaultScope(42)).toBe('off');
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
});
