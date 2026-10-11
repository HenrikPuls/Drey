import { decodeVector, encodeVector } from '../../shared/semantic';
import { VectorIndex } from './vector-index';

/**
 * The in-memory vector index: per-vault isolation, model-staleness,
 * top-k ranking with a score floor, and the JSON roundtrip.
 */

const MODEL = 'Xenova/multilingual-e5-small';

function vec(values: number[]): Float32Array {
  return Float32Array.from(values);
}

describe('VectorIndex', () => {
  it('ranks best first and honours k + minScore', () => {
    const index = new VectorIndex();
    index.setFile('v', MODEL, 'a.md', [
      { heading: 'Close', line: 1, vec: vec([1, 0]) },
      { heading: 'Far', line: 5, vec: vec([0, 1]) },
    ]);
    index.setFile('v', MODEL, 'b.md', [{ heading: 'Mid', line: 2, vec: vec([0.7, 0.7]) }]);

    const hits = index.search(['v'], MODEL, vec([1, 0]), 2, 0);
    expect(hits.map((h) => h.heading)).toEqual(['Close', 'Mid']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);

    const strict = index.search(['v'], MODEL, vec([1, 0]), 5, 0.95);
    expect(strict.map((h) => h.heading)).toEqual(['Close']);
  });

  it('keeps vaults isolated and skips stale-model vaults', () => {
    const index = new VectorIndex();
    index.setFile('one', MODEL, 'a.md', [{ heading: 'A', line: 1, vec: vec([1, 0]) }]);
    index.setFile('two', 'other-model', 'b.md', [{ heading: 'B', line: 1, vec: vec([1, 0]) }]);

    const hits = index.search(['one', 'two'], MODEL, vec([1, 0]), 10, 0);
    expect(hits.map((h) => h.vaultId)).toEqual(['one']);
    expect(index.isStale('two', MODEL)).toBe(true);
    expect(index.isStale('one', MODEL)).toBe(false);
    expect(index.isStale('missing', MODEL)).toBe(false);
  });

  it('setFile replaces the file contribution; empty records remove it', () => {
    const index = new VectorIndex();
    index.setFile('v', MODEL, 'a.md', [
      { heading: 'One', line: 1, vec: vec([1, 0]) },
      { heading: 'Two', line: 3, vec: vec([0, 1]) },
    ]);
    expect(index.sectionCount('v')).toBe(2);
    index.setFile('v', MODEL, 'a.md', [{ heading: 'One', line: 1, vec: vec([1, 0]) }]);
    expect(index.sectionCount('v')).toBe(1);
    index.setFile('v', MODEL, 'a.md', []);
    expect(index.sectionCount('v')).toBe(0);
    expect(index.fileExists('v', 'a.md')).toBe(false);
  });

  it('removeFile/dropVault/knownVaults mirror the tags index lifecycle', () => {
    const index = new VectorIndex();
    index.setFile('one', MODEL, 'a.md', [{ heading: 'A', line: 1, vec: vec([1, 0]) }]);
    index.setFile('two', MODEL, 'b.md', [{ heading: 'B', line: 1, vec: vec([1, 0]) }]);
    index.removeFile('one', 'a.md');
    expect(index.sectionCount('one')).toBe(0);
    index.dropVault('two');
    expect(index.knownVaults()).toContain('one');
    expect(index.knownVaults()).not.toContain('two');
  });

  it('survives the JSON roundtrip and rejects a model mismatch on load', () => {
    const index = new VectorIndex();
    index.setFile('v', MODEL, 'a.md', [
      { heading: 'Head', line: 7, vec: Float32Array.from([0.5, -0.25, 2]) },
    ]);
    const json = index.serialize('v');
    expect(json).not.toBeNull();

    const fresh = new VectorIndex();
    fresh.load('v', MODEL, json);
    const hits = fresh.search(['v'], MODEL, Float32Array.from([0.5, -0.25, 2]), 5, 0.99);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'a.md', heading: 'Head', line: 7 });
    const decoded = decodeVector(JSON.parse(json as string).sections[0].v);
    expect(decoded.length).toBe(3);

    const other = new VectorIndex();
    other.load('v', 'other-model', json);
    expect(other.sectionCount('v')).toBe(0);
    expect(other.search(['v'], 'other-model', Float32Array.from([1, 0, 0]), 5, 0)).toHaveLength(0);
  });

  it('a corrupt file yields nothing', () => {
    const index = new VectorIndex();
    index.load('v', MODEL, '{not json');
    expect(index.sectionCount('v')).toBe(0);
    index.load('v', MODEL, null);
    expect(index.sectionCount('v')).toBe(0);
  });

  it('outline lists paths with their headings in file order (ADR-0069)', () => {
    const index = new VectorIndex();
    expect(index.outline('v')).toEqual([]);
    index.setFile('v', MODEL, 'a.md', [
      { heading: 'One', line: 1, vec: vec([1, 0]) },
      { heading: 'Two', line: 3, vec: vec([0, 1]) },
    ]);
    index.setFile('v', MODEL, 'b.md', [{ heading: 'Three', line: 1, vec: vec([1, 1]) }]);
    index.setFile('stale', 'other-model', 'c.md', [{ heading: 'X', line: 1, vec: vec([1, 0]) }]);

    expect(index.outline('v')).toEqual([
      { path: 'a.md', headings: ['One', 'Two'] },
      { path: 'b.md', headings: ['Three'] },
    ]);
    // The model check keeps a stale vault out of the caller's overview.
    expect(index.outline('stale', MODEL)).toEqual([]);
    expect(index.outline('stale', 'other-model')).toEqual([
      { path: 'c.md', headings: ['X'] },
    ]);
  });
});
