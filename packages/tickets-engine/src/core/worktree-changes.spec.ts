import { describe, expect, it } from 'vitest';
import { MAX_WORKTREE_FILES, mergeWorktreeChanges, parseNameStatus, parseNumstat } from './worktree-changes';

describe('parseNumstat', () => {
  it('reads added, removed and the path; CRLF tolerantly', () => {
    const counts = parseNumstat('12\t0\tsrc/a.ts\r\n0\t5\tshared/b.ts\n');
    expect(counts.get('src/a.ts')).toEqual({ added: 12, removed: 0 });
    expect(counts.get('shared/b.ts')).toEqual({ added: 0, removed: 5 });
  });

  it('marks a binary file null on either side', () => {
    const counts = parseNumstat('-\t-\timg/logo.png\n3\t-\tpart.bin\n');
    expect(counts.get('img/logo.png')).toEqual({ added: null, removed: null });
    expect(counts.get('part.bin')).toEqual({ added: 3, removed: null });
  });

  it('keeps a path with spaces, skips anything not three columns', () => {
    const counts = parseNumstat('1\t2\tmy file with spaces.md\nnot a numstat line\n');
    expect(counts.get('my file with spaces.md')).toEqual({ added: 1, removed: 2 });
    expect(counts.has('not a numstat line')).toBe(false);
  });
});

describe('parseNameStatus', () => {
  it('reads plain letters and a rename score as R with the new path', () => {
    const statuses = parseNameStatus('A\tsrc/new.ts\nM\tsrc/a.ts\nR100\told/name.ts\tnew/name.ts\nD\tgone.ts\n');
    expect(statuses.get('src/new.ts')).toBe('A');
    expect(statuses.get('src/a.ts')).toBe('M');
    expect(statuses.get('new/name.ts')).toBe('R');
    expect(statuses.has('old/name.ts')).toBe(false);
    expect(statuses.get('gone.ts')).toBe('D');
  });
});

describe('mergeWorktreeChanges', () => {
  it('merges the committed and working passes: statuses latest-wins, counts sum', () => {
    const files = mergeWorktreeChanges([
      { numstat: '10\t2\tsrc/a.ts\n5\t0\tsrc/new.ts', nameStatus: 'M\tsrc/a.ts\nA\tsrc/new.ts' },
      { numstat: '3\t1\tsrc/a.ts', nameStatus: 'M\tsrc/a.ts' },
    ]);
    expect(files).toEqual([
      { status: 'M', path: 'src/a.ts', added: 13, removed: 3 },
      { status: 'A', path: 'src/new.ts', added: 5, removed: 0 },
    ]);
  });

  it('a deletion in the working tree wins over the committed status', () => {
    const files = mergeWorktreeChanges([
      { numstat: '5\t0\tsrc/x.ts', nameStatus: 'A\tsrc/x.ts' },
      { numstat: '0\t5\tsrc/x.ts', nameStatus: 'D\tsrc/x.ts' },
    ]);
    expect(files[0]).toEqual({ status: 'D', path: 'src/x.ts', added: 5, removed: 5 });
  });

  it('a binary file stays null even when the other pass counted', () => {
    const files = mergeWorktreeChanges([
      { numstat: '10\t2\tsrc/a.ts', nameStatus: 'M\tsrc/a.ts' },
      { numstat: '-\t-\tsrc/a.ts', nameStatus: 'M\tsrc/a.ts' },
    ]);
    expect(files[0]!.added).toBeNull();
    expect(files[0]!.removed).toBeNull();
  });

  it('falls back to M without a name-status entry, sorts by path, caps the list', () => {
    const many = Array.from({ length: MAX_WORKTREE_FILES + 10 }, (_, i) => `${String(i).padStart(3, '0')}.ts`);
    const files = mergeWorktreeChanges([{ numstat: many.map((p) => `1\t1\t${p}`).join('\n'), nameStatus: '' }]);
    expect(files).toHaveLength(MAX_WORKTREE_FILES);
    expect(files[0]!.status).toBe('M');
    expect(files.map((f) => f.path)).toEqual([...many].sort().slice(0, MAX_WORKTREE_FILES));
  });

  it('empty inputs give an empty list', () => {
    expect(mergeWorktreeChanges([{ numstat: '', nameStatus: '' }])).toEqual([]);
    expect(mergeWorktreeChanges([])).toEqual([]);
  });
});
