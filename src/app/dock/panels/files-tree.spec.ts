import { VaultFileEntry, VaultStatus } from '../../../../shared/ipc-api';
import {
  TreeTarget,
  absolutePath,
  ancestorKeys,
  canDropOnEntry,
  canDropOnVault,
  destinationDir,
  directoryKeys,
  everyFolderExpanded,
  flattenVisible,
  isInvalidEntryName,
  keyOf,
  parentDir,
  rangeOver,
} from './files-tree';

const V1: VaultStatus = { id: 'v1', name: 'one', path: 'C:\\vaults\\one', exists: true, active: true };
const V2: VaultStatus = { id: 'v2', name: 'two', path: '/home/u/two', exists: true, active: false };

const file = (relativePath: string): VaultFileEntry => ({
  name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
  relativePath,
  type: 'file',
});

const dir = (relativePath: string, children: VaultFileEntry[] = []): VaultFileEntry => ({
  name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
  relativePath,
  type: 'directory',
  children,
});

/** v1: a.md · notes/ (b.md · deep/ (c.md)) -- v2: z.md */
const trees: Record<string, VaultFileEntry[]> = {
  v1: [file('a.md'), dir('notes', [file('notes/b.md'), dir('notes/deep', [file('notes/deep/c.md')])])],
  v2: [file('z.md')],
};

const keys = (collapsedVaults: string[], expanded: string[]): string[] =>
  flattenVisible([V1, V2], trees, new Set(collapsedVaults), new Set(expanded)).map(keyOf);

describe('flattenVisible', () => {
  it('shows vault rows and top-level entries while every folder is collapsed', () => {
    expect(keys([], [])).toEqual(['v1', 'v1::a.md', 'v1::notes', 'v2', 'v2::z.md']);
  });

  it('descends only into expanded folders', () => {
    expect(keys([], ['v1::notes'])).toEqual([
      'v1',
      'v1::a.md',
      'v1::notes',
      'v1::notes/b.md',
      'v1::notes/deep',
      'v2',
      'v2::z.md',
    ]);
  });

  it('keeps a nested folder hidden while its parent is collapsed', () => {
    expect(keys([], ['v1::notes/deep'])).toEqual(['v1', 'v1::a.md', 'v1::notes', 'v2', 'v2::z.md']);
  });

  it('hides the whole tree of a collapsed vault but keeps its row', () => {
    expect(keys(['v1'], ['v1::notes'])).toEqual(['v1', 'v2', 'v2::z.md']);
  });

  it('reports the nesting depth of each entry', () => {
    const nodes = flattenVisible([V1], trees, new Set(), new Set(['v1::notes', 'v1::notes/deep']));
    const depths = nodes.map((n) => (n.kind === 'entry' ? n.depth : -1));
    expect(depths).toEqual([-1, 0, 0, 1, 1, 2]);
  });

  it('shows a vault without a loaded tree as its row alone', () => {
    expect(flattenVisible([V1], {}, new Set(), new Set()).map(keyOf)).toEqual(['v1']);
  });
});

describe('directoryKeys / everyFolderExpanded', () => {
  it('collects every folder of every vault', () => {
    expect([...directoryKeys(trees)]).toEqual(['v1::notes', 'v1::notes/deep']);
  });

  it('is true only once no folder is left collapsed', () => {
    expect(everyFolderExpanded(trees, new Set(['v1::notes']))).toBe(false);
    expect(everyFolderExpanded(trees, new Set(['v1::notes', 'v1::notes/deep']))).toBe(true);
  });

  it('is true for trees without folders', () => {
    expect(everyFolderExpanded({ v2: trees['v2'] }, new Set())).toBe(true);
  });
});

describe('ancestorKeys', () => {
  it('lists the folder and everything above it, outermost first', () => {
    expect(ancestorKeys('v1', 'notes/deep')).toEqual(['v1::notes', 'v1::notes/deep']);
  });

  it('is empty for the vault root', () => {
    expect(ancestorKeys('v1', '')).toEqual([]);
  });
});

describe('rangeOver', () => {
  const nodes = flattenVisible([V1, V2], trees, new Set(), new Set());

  it('covers both ends in either direction', () => {
    const expected = ['v1::a.md', 'v1::notes', 'v2'];
    expect([...rangeOver(nodes, 'v1::a.md', 'v2')]).toEqual(expected);
    expect([...rangeOver(nodes, 'v2', 'v1::a.md')]).toEqual(expected);
  });

  it('falls back to the target row when an end is no longer visible', () => {
    expect([...rangeOver(nodes, 'v1::gone.md', 'v2::z.md')]).toEqual(['v2::z.md']);
  });
});

describe('absolutePath', () => {
  it('joins in the separator style of the vault root', () => {
    expect(absolutePath(V1.path, 'notes/b.md')).toBe('C:\\vaults\\one\\notes\\b.md');
    expect(absolutePath(V2.path, 'notes/b.md')).toBe('/home/u/two/notes/b.md');
  });

  it('does not double a trailing separator', () => {
    expect(absolutePath('C:\\vaults\\one\\', 'a.md')).toBe('C:\\vaults\\one\\a.md');
  });

  it('degrades to the relative path without a root', () => {
    expect(absolutePath(undefined, 'notes/b.md')).toBe('notes/b.md');
  });
});

describe('drop targets', () => {
  const dragged = (entry: VaultFileEntry, vaultId = 'v1'): TreeTarget => ({ vaultId, entry });

  it('a folder row takes the entry in, a file row means its folder', () => {
    expect(destinationDir(dir('notes'))).toBe('notes');
    expect(destinationDir(file('notes/b.md'))).toBe('notes');
    expect(destinationDir(file('a.md'))).toBe('');
  });

  it('refuses a drop without a drag', () => {
    expect(canDropOnEntry(null, 'v1', dir('notes'))).toBe(false);
    expect(canDropOnVault(null, V1)).toBe(false);
  });

  it('refuses a move into the folder the entry is already in', () => {
    expect(canDropOnEntry(dragged(file('notes/b.md')), 'v1', dir('notes'))).toBe(false);
    expect(canDropOnEntry(dragged(file('notes/b.md')), 'v1', file('notes/x.md'))).toBe(false);
  });

  it('refuses a folder dropped on itself or into its own subtree', () => {
    expect(canDropOnEntry(dragged(dir('notes')), 'v1', dir('notes'))).toBe(false);
    expect(canDropOnEntry(dragged(dir('notes')), 'v1', dir('notes/deep'))).toBe(false);
  });

  it('accepts a move into another folder of the same vault', () => {
    expect(canDropOnEntry(dragged(file('a.md')), 'v1', dir('notes'))).toBe(true);
    // A sibling folder whose name merely starts the same is not a subtree.
    expect(canDropOnEntry(dragged(dir('notes')), 'v1', dir('notes-old'))).toBe(true);
  });

  it('accepts every cross-vault drop on a row', () => {
    expect(canDropOnEntry(dragged(file('notes/b.md'), 'v2'), 'v1', dir('notes'))).toBe(true);
  });

  it('a vault row accepts what is not already in its root', () => {
    expect(canDropOnVault(dragged(file('a.md')), V1)).toBe(false);
    expect(canDropOnVault(dragged(file('notes/b.md')), V1)).toBe(true);
    expect(canDropOnVault(dragged(file('a.md')), V2)).toBe(true);
  });

  it('a vault whose folder is missing accepts nothing', () => {
    expect(canDropOnVault(dragged(file('a.md')), { ...V2, exists: false })).toBe(false);
  });
});

describe('names and paths', () => {
  it('parentDir is empty for a root entry', () => {
    expect(parentDir('a.md')).toBe('');
    expect(parentDir('notes/deep/c.md')).toBe('notes/deep');
  });

  it('rejects names that are not one path segment', () => {
    for (const name of ['a/b', 'a\\b', '.', '..']) {
      expect(isInvalidEntryName(name)).toBe(true);
    }
    expect(isInvalidEntryName('.hidden')).toBe(false);
    expect(isInvalidEntryName('note.md')).toBe(false);
  });
});
