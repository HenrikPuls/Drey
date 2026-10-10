import {
  changeCount,
  decorationsFor,
  isPlausibleBranchName,
  parseBranches,
  parseLog,
  parseNameStatus,
  parseStatus,
  toRepoPath,
  toVaultPath,
} from '../../../plugins/git/shared/status';

/**
 * The Git plugin's pure half (`plugins/git/shared/status`): the parsers for
 * git's output and the repository <-> vault path mapping. Lives here because
 * the unit suite runs the specs under `src/`.
 */

const H = '0000000000000000000000000000000000000000';
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** Joins porcelain records the way `-z` does: NUL after every one. */
function z(...records: string[]): string {
  return records.map((r) => `${r}\0`).join('');
}

describe('parseStatus', () => {
  it('reads the branch header: name, commit, upstream, ahead / behind', () => {
    const status = parseStatus(
      z(`# branch.oid ${A}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1'),
      '',
    );
    expect(status).toMatchObject({
      branch: 'main',
      head: 'a1b2c3d',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      staged: [],
      unstaged: [],
      conflicts: [],
    });
  });

  it('reports a detached HEAD and a repository without commits as null', () => {
    expect(parseStatus(z(`# branch.oid ${A}`, '# branch.head (detached)'), '').branch).toBeNull();
    const fresh = parseStatus(z('# branch.oid (initial)', '# branch.head main'), '');
    expect(fresh.head).toBeNull();
    expect(fresh.upstream).toBeNull();
  });

  it('splits an entry into its staged and its working-tree half', () => {
    const status = parseStatus(
      z(
        `1 M. N... 100644 100644 100644 ${A} ${A} staged only.md`,
        `1 .M N... 100644 100644 100644 ${A} ${A} docs/edited.md`,
        `1 MM N... 100644 100644 100644 ${A} ${A} both.md`,
        `1 A. N... 000000 100644 100644 ${H} ${A} new.md`,
        `1 .D N... 100644 100644 000000 ${A} ${A} gone.md`,
        '? notes/untracked file.md',
        '! ignored.log',
      ),
      '',
    );
    expect(status.staged).toEqual([
      { path: 'staged only.md', kind: 'modified' },
      { path: 'both.md', kind: 'modified' },
      { path: 'new.md', kind: 'added' },
    ]);
    expect(status.unstaged).toEqual([
      { path: 'docs/edited.md', kind: 'modified' },
      { path: 'both.md', kind: 'modified' },
      { path: 'gone.md', kind: 'deleted' },
      { path: 'notes/untracked file.md', kind: 'untracked' },
    ]);
  });

  it('reads a rename with its original path from the following field', () => {
    const status = parseStatus(
      z(`2 R. N... 100644 100644 100644 ${A} ${A} R100 new name.md`, 'old name.md', '? after.md'),
      '',
    );
    expect(status.staged).toEqual([{ path: 'new name.md', kind: 'renamed', origPath: 'old name.md' }]);
    expect(status.unstaged).toEqual([{ path: 'after.md', kind: 'untracked' }]);
  });

  it('lists unmerged paths as conflicts', () => {
    const status = parseStatus(z(`u UU N... 100644 100644 100644 100644 ${A} ${A} ${A} docs/clash.md`), '');
    expect(status.conflicts).toEqual([{ path: 'docs/clash.md', kind: 'conflict' }]);
  });

  it('maps repository paths into a vault that is a subfolder, dropping the rest', () => {
    const status = parseStatus(
      z(
        `1 .M N... 100644 100644 100644 ${A} ${A} docs/index.md`,
        `1 .M N... 100644 100644 100644 ${A} ${A} src/main.ts`,
        `2 R. N... 100644 100644 100644 ${A} ${A} R090 docs/moved.md`,
        'README.md',
        '? docs/img/new.png',
      ),
      'docs/',
    );
    expect(status.unstaged).toEqual([
      { path: 'index.md', kind: 'modified' },
      { path: 'img/new.png', kind: 'untracked' },
    ]);
    // The original lies outside the vault: the rename is kept, its origin is not.
    expect(status.staged).toEqual([{ path: 'moved.md', kind: 'renamed' }]);
  });
});

describe('path mapping', () => {
  it('is the identity for a vault at the repository root', () => {
    expect(toVaultPath('a/b.md', '')).toBe('a/b.md');
    expect(toRepoPath('a/b.md', '')).toBe('a/b.md');
  });

  it('strips and re-adds the vault folder', () => {
    expect(toVaultPath('docs/a/b.md', 'docs/')).toBe('a/b.md');
    expect(toVaultPath('docs2/a.md', 'docs/')).toBeNull();
    expect(toVaultPath('docs/', 'docs/')).toBeNull();
    expect(toRepoPath('a/b.md', 'docs/')).toBe('docs/a/b.md');
  });
});

describe('decorationsFor', () => {
  it('shows the working-tree state over the staged one, a conflict over both', () => {
    const decorations = decorationsFor({
      branch: 'main',
      head: 'a1b2c3d',
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [
        { path: 'a.md', kind: 'added' },
        { path: 'b.md', kind: 'modified' },
      ],
      unstaged: [
        { path: 'a.md', kind: 'modified' },
        { path: 'c.md', kind: 'untracked' },
        { path: 'd.md', kind: 'deleted' },
      ],
      conflicts: [{ path: 'b.md', kind: 'conflict' }],
    });
    expect(decorations).toEqual([
      { path: 'a.md', badge: 'M', tone: 'modified', tooltip: 'Modified' },
      { path: 'b.md', badge: '!', tone: 'conflict', tooltip: 'Merge conflict' },
      { path: 'c.md', badge: 'U', tone: 'untracked', tooltip: 'Untracked' },
      { path: 'd.md', badge: 'D', tone: 'deleted', tooltip: 'Deleted' },
    ]);
  });

  it('marks a change that is only staged as such, and counts a path once', () => {
    const status = {
      branch: 'main',
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [{ path: 'a.md', kind: 'added' as const }],
      unstaged: [{ path: 'a.md', kind: 'modified' as const }],
      conflicts: [],
    };
    expect(decorationsFor({ ...status, unstaged: [] })).toEqual([
      { path: 'a.md', badge: 'A', tone: 'added', tooltip: 'Added, staged' },
    ]);
    expect(changeCount(status)).toBe(1);
  });
});

describe('parseLog', () => {
  it('splits records and fields, keeping a subject with any character', () => {
    const out =
      'a1b2c3d\x1fAda\x1f2026-10-09T08:15:00+02:00\x1fFix: links | tables\x1e\n' +
      'b2c3d4e\x1fGrace Hopper\x1f2026-10-08T17:00:00+02:00\x1fInitial commit\x1e';
    expect(parseLog(out)).toEqual([
      { hash: 'a1b2c3d', author: 'Ada', date: '2026-10-09T08:15:00+02:00', subject: 'Fix: links | tables' },
      { hash: 'b2c3d4e', author: 'Grace Hopper', date: '2026-10-08T17:00:00+02:00', subject: 'Initial commit' },
    ]);
    expect(parseLog('')).toEqual([]);
  });
});

describe('parseBranches', () => {
  it('puts the current branch first and hides remote twins of local branches', () => {
    const out = [
      'refs/heads/feature/x\x1ffeature/x\x1f ',
      'refs/heads/main\x1fmain\x1f*',
      'refs/remotes/origin/HEAD\x1forigin/HEAD\x1f ',
      'refs/remotes/origin/main\x1forigin/main\x1f ',
      'refs/remotes/origin/release/1.0\x1forigin/release/1.0\x1f ',
    ].join('\n');
    expect(parseBranches(out)).toEqual([
      { name: 'main', remote: false, current: true },
      { name: 'feature/x', remote: false, current: false },
      { name: 'origin/release/1.0', remote: true, current: false },
    ]);
  });
});

describe('parseNameStatus', () => {
  it('separates rewritten files from removed ones', () => {
    expect(parseNameStatus(z('M', 'a.md', 'A', 'new dir/b.md', 'D', 'gone.md', 'T', 'link.md'))).toEqual({
      changed: ['a.md', 'new dir/b.md', 'link.md'],
      deleted: ['gone.md'],
    });
    expect(parseNameStatus('')).toEqual({ changed: [], deleted: [] });
  });
});

describe('isPlausibleBranchName', () => {
  it('accepts ordinary names and rejects options, ranges and whitespace', () => {
    for (const name of ['main', 'feature/login', 'fix-12', 'release/1.0']) {
      expect(isPlausibleBranchName(name)).toBe(true);
    }
    for (const name of ['', '-b', '--force', 'a b', 'a..b', 'a:b', 'x.lock', 'trailing/', 'a@{1}', 'q?']) {
      expect(isPlausibleBranchName(name)).toBe(false);
    }
  });
});
