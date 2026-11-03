import { describe, expect, it } from 'vitest';
import { isSafeRepoPath, MAX_WORKTREE_FILES, mergeWorktreeChanges, parseNameStatus, parseNumstat, parseUnifiedDiff } from './worktree-changes';

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

describe('parseUnifiedDiff', () => {
  const SAMPLE = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/src/gone.ts b/src/gone.ts',
    'deleted file mode 100644',
    '--- a/src/gone.ts',
    '+++ /dev/null',
  ].join('\n');

  it('splits per file with statuses from the header lines', () => {
    const diff = parseUnifiedDiff(SAMPLE, { maxFiles: 10, maxPatchBytes: 10_000, maxTotalBytes: 100_000 });
    expect(diff.truncated).toBe(false);
    expect(diff.files.map((f) => [f.status, f.path])).toEqual([
      ['M', 'src/a.ts'],
      ['A', 'src/new.ts'],
      ['D', 'src/gone.ts'],
    ]);
    expect(diff.files[0]!.patch).toContain('@@ -1,2 +1,2 @@');
    expect(diff.files[0]!.patch).toContain('+new line');
  });

  it('caps at the file boundary and says truncated', () => {
    const diff = parseUnifiedDiff(SAMPLE, { maxFiles: 2, maxPatchBytes: 10_000, maxTotalBytes: 100_000 });
    expect(diff.files).toHaveLength(2);
    expect(diff.truncated).toBe(true);
  });

  it('marks a patch beyond its byte cap but keeps the file', () => {
    const diff = parseUnifiedDiff(SAMPLE, { maxFiles: 10, maxPatchBytes: 40, maxTotalBytes: 100_000 });
    expect(diff.truncated).toBe(true);
    expect(diff.files[0]!.patch.length).toBeLessThanOrEqual(80);
  });

  it('reads an empty diff as no files', () => {
    expect(parseUnifiedDiff('', { maxFiles: 10, maxPatchBytes: 10_000, maxTotalBytes: 100_000 })).toEqual({
      files: [],
      truncated: false,
    });
  });
});

describe('isSafeRepoPath', () => {
  it('accepts repo-relative paths only', () => {
    expect(isSafeRepoPath('src/app/a.ts')).toBe(true);
    expect(isSafeRepoPath('')).toBe(false);
    expect(isSafeRepoPath('/etc/passwd')).toBe(false);
    expect(isSafeRepoPath('../x')).toBe(false);
    expect(isSafeRepoPath('a/../b')).toBe(false);
    expect(isSafeRepoPath('a//b')).toBe(false);
    expect(isSafeRepoPath('a\\b')).toBe(false);
    expect(isSafeRepoPath('main:secret')).toBe(false);
  });
});
