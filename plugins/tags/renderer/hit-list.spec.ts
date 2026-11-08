/**
 * The Search panel's list helpers (`hit-list.ts`) and its stored prefs
 * (`search-prefs.ts`): pure functions, tested without a DOM.
 */
import { describe, expect, it } from 'vitest';
import type { TagSearchHit, TagSearchQuery } from '../../../shared/plugin-api/renderer';
import { groupHits, mergeOpenBufferHits, snippetParts, splitPath } from './hit-list.js';
import { DEFAULT_PREFS, parsePrefs } from './search-prefs.js';

function hit(path: string, line: number, vaultId?: string): TagSearchHit {
  return { path, line, heading: 'H', snippet: 's', vaultId } as TagSearchHit;
}

const QUERY: TagSearchQuery = {
  tags: [],
  text: 'alpha',
  match: { caseSensitive: false, wholeWord: false, regex: false },
};

describe('mergeOpenBufferHits', () => {
  it('returns the disk hits unchanged when no tab is dirty', () => {
    const disk = [hit('b.md', 1, 'v1'), hit('a.md', 1, 'v1')];
    expect(mergeOpenBufferHits(disk, [], QUERY)).toEqual(disk);
  });

  it('replaces a dirty file’s disk hits by what its buffer matches', () => {
    const disk = [hit('a.md', 9, 'v1'), hit('b.md', 1, 'v1')];
    const dirty = [{ path: 'a.md', vaultId: 'v1', buffer: '# Title\n\nalpha here\n' }];
    const merged = mergeOpenBufferHits(disk, dirty, QUERY);
    expect(merged.map((h) => [h.path, h.unsaved === true])).toEqual([
      ['a.md', true],
      ['b.md', false],
    ]);
    expect(merged[0].vaultId).toBe('v1');
    expect(merged[0].line).not.toBe(9);
  });

  it('drops a dirty file whose buffer no longer matches', () => {
    const disk = [hit('a.md', 3, 'v1')];
    const dirty = [{ path: 'a.md', vaultId: 'v1', buffer: '# Title\n\nbeta\n' }];
    expect(mergeOpenBufferHits(disk, dirty, QUERY)).toEqual([]);
  });

  it('keeps the same path in another vault', () => {
    const disk = [hit('a.md', 3, 'v2')];
    const dirty = [{ path: 'a.md', vaultId: 'v1', buffer: 'nothing' }];
    expect(mergeOpenBufferHits(disk, dirty, QUERY)).toEqual(disk);
  });

  it('sorts by path, then vault, then line', () => {
    const disk = [hit('b.md', 2, 'v1'), hit('a.md', 5, 'v2'), hit('a.md', 1, 'v2'), hit('a.md', 7, 'v1')];
    const dirty = [{ path: 'zzz.md', vaultId: 'v1', buffer: 'nothing' }];
    expect(mergeOpenBufferHits(disk, dirty, QUERY).map((h) => `${h.path} ${h.vaultId} ${h.line}`)).toEqual([
      'a.md v1 7',
      'a.md v2 1',
      'a.md v2 5',
      'b.md v1 2',
    ]);
  });
});

describe('groupHits', () => {
  it('groups per file and sorts the files by path', () => {
    const groups = groupHits([hit('b.md', 1, 'v1'), hit('a.md', 4, 'v1'), hit('b.md', 8, 'v1')]);
    expect(groups.map((g) => [g.path, g.hits.map((h) => h.line)])).toEqual([
      ['a.md', [4]],
      ['b.md', [1, 8]],
    ]);
  });

  it('keeps the same path of two vaults apart', () => {
    const groups = groupHits([hit('a.md', 1, 'v2'), hit('a.md', 1, 'v1')]);
    expect(groups.map((g) => g.vaultId)).toEqual(['v1', 'v2']);
  });

  it('gives a hit without a vault a null vault id', () => {
    expect(groupHits([hit('a.md', 1)])[0].vaultId).toBeNull();
  });
});

describe('parsePrefs', () => {
  it('falls back to the defaults for nothing stored or broken JSON', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{')).toEqual(DEFAULT_PREFS);
  });

  it('reads stored choices', () => {
    expect(parsePrefs('{"scope":"all","regex":true}')).toEqual({
      ...DEFAULT_PREFS,
      scope: 'all',
      regex: true,
    });
  });

  it('ignores an unknown scope and non-boolean flags', () => {
    expect(parsePrefs('{"scope":"galaxy","matchCase":"yes"}')).toEqual(DEFAULT_PREFS);
  });
});

describe('snippetParts', () => {
  const text = (q: Partial<TagSearchQuery['match']> & { text: string }): TagSearchQuery => ({
    tags: [],
    text: q.text,
    match: { caseSensitive: false, wholeWord: false, regex: false, ...q },
  });

  it('marks every occurrence of each term, case-insensitive by default', () => {
    expect(snippetParts('The new Logo and the logo', text({ text: 'logo' }))).toEqual([
      { text: 'The new ', mark: false },
      { text: 'Logo', mark: true },
      { text: ' and the ', mark: false },
      { text: 'logo', mark: true },
    ]);
  });

  it('respects match case and regex, and survives an invalid pattern', () => {
    expect(snippetParts('Logo logo', text({ text: 'logo', caseSensitive: true })).filter((p) => p.mark)).toHaveLength(1);
    expect(snippetParts('a1 b22', text({ text: '[0-9]+', regex: true })).filter((p) => p.mark).map((p) => p.text)).toEqual(['1', '22']);
    expect(snippetParts('x(', text({ text: 'logo(', regex: true }))).toEqual([{ text: 'x(', mark: false }]);
  });

  it('returns the snippet as one plain run without text', () => {
    expect(snippetParts('abc', { tags: ['x'], text: '' })).toEqual([{ text: 'abc', mark: false }]);
  });
});

describe('splitPath', () => {
  it('splits the name from its folder', () => {
    expect(splitPath('projects/website-relaunch.md')).toEqual({ name: 'website-relaunch.md', folder: 'projects' });
    expect(splitPath('a.md')).toEqual({ name: 'a.md', folder: '' });
  });
});
