import { describe, expect, it } from 'vitest';
import {
  changeCount,
  decorationsFor,
  isCommitId,
  isPlausibleBranchName,
  mergeSourceFromMessage,
  parseBranches,
  parseLog,
  parseNameStatus,
  parsePatch,
  parseStashList,
  parseStatus,
  toRepoPath,
  toVaultPath,
} from './status';

const H = '0'.repeat(40);

/** Joins porcelain-v2 records the way `git status -z` prints them. */
const z = (...records: string[]): string => records.map((record) => `${record}\0`).join('');
const ordinary = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 ${H} ${H} ${path}`;
const renamed = (xy: string, path: string, orig: string): string =>
  `2 ${xy} N... 100644 100644 100644 ${H} ${H} R100 ${path}\0${orig}`;
const unmerged = (path: string): string => `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} ${path}`;

describe('toVaultPath / toRepoPath', () => {
  it('passes paths through when the vault is the repository root', () => {
    expect(toVaultPath('notes/a.md', '')).toBe('notes/a.md');
    expect(toRepoPath('notes/a.md', '')).toBe('notes/a.md');
  });

  it('strips the vault folder and drops what lies outside it', () => {
    expect(toVaultPath('docs/a.md', 'docs/')).toBe('a.md');
    expect(toVaultPath('src/a.ts', 'docs/')).toBeNull();
    expect(toVaultPath('docs-old/a.md', 'docs/')).toBeNull();
    expect(toVaultPath('docs/', 'docs/')).toBeNull();
    expect(toRepoPath('a.md', 'docs/')).toBe('docs/a.md');
  });
});

describe('parseStatus', () => {
  it('reads the branch header', () => {
    const status = parseStatus(
      z(`# branch.oid abcdef1234567890`, '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +2 -1'),
      '',
    );
    expect(status).toEqual({
      branch: 'feature/x',
      head: 'abcdef1',
      upstream: 'origin/feature/x',
      ahead: 2,
      behind: 1,
      staged: [],
      unstaged: [],
      conflicts: [],
    });
  });

  it('reports a detached HEAD and a repository without commits', () => {
    const status = parseStatus(z('# branch.oid (initial)', '# branch.head (detached)'), '');
    expect(status.branch).toBeNull();
    expect(status.head).toBeNull();
    expect(status.upstream).toBeNull();
  });

  it('sorts changes into staged and unstaged, a file changed twice into both', () => {
    const status = parseStatus(
      z(
        ordinary('.M', 'tree only.md'),
        ordinary('M.', 'index-only.md'),
        ordinary('MM', 'both.md'),
        ordinary('A.', 'new.md'),
        ordinary('.D', 'gone.md'),
        ordinary('T.', 'type-changed.md'),
        '? untracked file.md',
        '! ignored.log',
      ),
      '',
    );

    expect(status.staged).toEqual([
      { path: 'index-only.md', kind: 'modified' },
      { path: 'both.md', kind: 'modified' },
      { path: 'new.md', kind: 'added' },
      { path: 'type-changed.md', kind: 'modified' },
    ]);
    expect(status.unstaged).toEqual([
      { path: 'tree only.md', kind: 'modified' },
      { path: 'both.md', kind: 'modified' },
      { path: 'gone.md', kind: 'deleted' },
      { path: 'untracked file.md', kind: 'untracked' },
    ]);
    expect(changeCount(status)).toBe(7);
  });

  it('reads a rename with its original path and keeps the records after it aligned', () => {
    const status = parseStatus(z(renamed('R.', 'new name.md', 'old name.md'), ordinary('.M', 'after.md')), '');
    expect(status.staged).toEqual([{ path: 'new name.md', kind: 'renamed', origPath: 'old name.md' }]);
    expect(status.unstaged).toEqual([{ path: 'after.md', kind: 'modified' }]);
  });

  it('lists merge conflicts separately', () => {
    const status = parseStatus(z(unmerged('both changed.md'), ordinary('M.', 'clean.md')), '');
    expect(status.conflicts).toEqual([{ path: 'both changed.md', kind: 'conflict' }]);
    expect(status.staged).toEqual([{ path: 'clean.md', kind: 'modified' }]);
  });

  it('keeps only what lies inside a vault that is a folder of the repository', () => {
    const status = parseStatus(
      z(
        ordinary('M.', 'docs/in.md'),
        ordinary('M.', 'src/out.ts'),
        '? docs/new.md',
        '? README.md',
        unmerged('src/conflict.ts'),
        // Moved into the vault from outside: the old path is not a vault path.
        renamed('R.', 'docs/moved-in.md', 'elsewhere/moved-in.md'),
        // Moved out of the vault: the record is dropped, the next one still parses.
        renamed('R.', 'elsewhere/moved-out.md', 'docs/moved-out.md'),
        ordinary('.M', 'docs/last.md'),
      ),
      'docs/',
    );

    expect(status.staged).toEqual([
      { path: 'in.md', kind: 'modified' },
      { path: 'moved-in.md', kind: 'renamed' },
    ]);
    expect(status.unstaged).toEqual([
      { path: 'new.md', kind: 'untracked' },
      { path: 'last.md', kind: 'modified' },
    ]);
    expect(status.conflicts).toEqual([]);
  });

  it('survives empty and truncated output', () => {
    expect(parseStatus('', '').staged).toEqual([]);
    expect(parseStatus(z('1 M.'), '').staged).toEqual([{ path: '', kind: 'modified' }]);
  });
});

describe('decorationsFor', () => {
  it('shows what the file on disk is like: conflict over working tree over staged', () => {
    const decorations = decorationsFor({
      branch: 'main',
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: [
        { path: 'staged.md', kind: 'added' },
        { path: 'twice.md', kind: 'modified' },
        { path: 'fight.md', kind: 'modified' },
      ],
      unstaged: [
        { path: 'twice.md', kind: 'deleted' },
        { path: 'new.md', kind: 'untracked' },
      ],
      conflicts: [{ path: 'fight.md', kind: 'conflict' }],
    });

    expect(decorations).toEqual([
      { path: 'staged.md', badge: 'A', tone: 'added', tooltip: 'Added, staged' },
      { path: 'twice.md', badge: 'D', tone: 'deleted', tooltip: 'Deleted' },
      { path: 'fight.md', badge: '!', tone: 'conflict', tooltip: 'Merge conflict' },
      { path: 'new.md', badge: 'U', tone: 'untracked', tooltip: 'Untracked' },
    ]);
  });
});

describe('parseLog', () => {
  it('reads one entry per record, subjects with any punctuation', () => {
    const output =
      'abc1234\x1fAda L.\x1f2026-10-01T10:00:00+02:00\x1ffix: a | b, "c"\x1fabc1234ffff\x1e\n' +
      'def5678\x1fBob\x1f2026-09-30T09:00:00+02:00\x1f\x1fdef5678ffff\x1e\n';

    expect(parseLog(output)).toEqual([
      { hash: 'abc1234', author: 'Ada L.', date: '2026-10-01T10:00:00+02:00', subject: 'fix: a | b, "c"', id: 'abc1234ffff' },
      { hash: 'def5678', author: 'Bob', date: '2026-09-30T09:00:00+02:00', subject: '', id: 'def5678ffff' },
    ]);
    expect(parseLog('')).toEqual([]);
  });

  it('accepts the older format without the full id', () => {
    expect(parseLog('abc1234\x1fAda\x1f2026-10-01\x1fsubject\x1e')).toEqual([
      { hash: 'abc1234', author: 'Ada', date: '2026-10-01', subject: 'subject' },
    ]);
  });
});

describe('parseBranches', () => {
  it('puts the current branch first and hides remote branches that have a local twin', () => {
    const line = (ref: string, name: string, head = ' '): string => `${ref}\x1f${name}\x1f${head}`;
    const output = [
      line('refs/heads/zeta', 'zeta'),
      line('refs/heads/main', 'main', '*'),
      line('refs/heads/alpha', 'alpha'),
      line('refs/remotes/origin/HEAD', 'origin'),
      line('refs/remotes/origin/main', 'origin/main'),
      line('refs/remotes/origin/feature/x', 'origin/feature/x'),
      line('refs/tags/v1', 'v1'),
      '',
    ].join('\n');

    expect(parseBranches(output)).toEqual([
      { name: 'main', remote: false, current: true },
      { name: 'alpha', remote: false, current: false },
      { name: 'zeta', remote: false, current: false },
      { name: 'origin/feature/x', remote: true, current: false },
    ]);
  });
});

describe('parseNameStatus', () => {
  it('separates rewritten from removed files', () => {
    expect(parseNameStatus('M\0a b.md\0D\0gone.md\0A\0new.md\0')).toEqual({
      changed: ['a b.md', 'new.md'],
      deleted: ['gone.md'],
    });
    expect(parseNameStatus('')).toEqual({ changed: [], deleted: [] });
  });
});

describe('parseStashList', () => {
  it('numbers the stashes in list order', () => {
    expect(parseStashList('On main: my note\x1f2026-10-02T08:00:00+02:00\x1e\nWIP on main: abc subject\x1f2026-10-01T08:00:00+02:00\x1e\n')).toEqual([
      { index: 0, message: 'On main: my note', date: '2026-10-02T08:00:00+02:00' },
      { index: 1, message: 'WIP on main: abc subject', date: '2026-10-01T08:00:00+02:00' },
    ]);
    expect(parseStashList('')).toEqual([]);
  });
});

describe('mergeSourceFromMessage', () => {
  it('names what is being merged', () => {
    expect(mergeSourceFromMessage("Merge branch 'feature/x'\n\n# Conflicts:\n#\ta.md\n")).toBe('feature/x');
    expect(mergeSourceFromMessage("Merge remote-tracking branch 'origin/main' into topic")).toBe('origin/main');
    expect(mergeSourceFromMessage("Merge tag 'v1.2'")).toBe('v1.2');
    expect(mergeSourceFromMessage('A hand-written message')).toBeNull();
  });
});

describe('parsePatch', () => {
  it('drops the file header and the no-newline marker', () => {
    const output = [
      'diff --git a/note.md b/note.md',
      'index 111..222 100644',
      '--- a/note.md',
      '+++ b/note.md',
      '@@ -1,3 +1,3 @@ # Title',
      ' kept',
      '-old line',
      '+new line',
      '\\ No newline at end of file',
      '',
    ].join('\r\n');

    expect(parsePatch(output)).toEqual([
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@ # Title' },
      { kind: 'context', text: 'kept' },
      { kind: 'del', text: 'old line' },
      { kind: 'add', text: 'new line' },
    ]);
  });

  it('yields nothing for a binary file', () => {
    expect(parsePatch('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')).toEqual([]);
  });
});

describe('argument checks', () => {
  it('accepts only hexadecimal commit ids', () => {
    expect(isCommitId('abc1')).toBe(true);
    expect(isCommitId('A'.repeat(40))).toBe(true);
    expect(isCommitId('abc')).toBe(false);
    expect(isCommitId('a'.repeat(41))).toBe(false);
    expect(isCommitId('--all')).toBe(false);
    expect(isCommitId('HEAD~1')).toBe(false);
  });

  it('refuses branch names git rejects or would read as an option', () => {
    for (const ok of ['main', 'feature/x', 'fix-1.2', 'ümlaut']) {
      expect(isPlausibleBranchName(ok)).toBe(true);
    }
    for (const bad of ['', '-D', '--force', '/x', 'x/', 'x.', 'x.lock', 'a..b', 'a@{1}', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a\tb']) {
      expect(isPlausibleBranchName(bad)).toBe(false);
    }
  });
});

// A second set of fixtures for the same parsers, written against real git output.
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

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

  it('carries the full commit id when the log was asked for it', () => {
    const out = `a1b2c3d\x1fAda\x1f2026-10-09T08:15:00+02:00\x1fFix\x1f${A}\x1e`;
    expect(parseLog(out)).toEqual([
      { hash: 'a1b2c3d', author: 'Ada', date: '2026-10-09T08:15:00+02:00', subject: 'Fix', id: A },
    ]);
  });
});

describe('parseStashList', () => {
  it('numbers the stashes in git order and keeps the description whole', () => {
    const out =
      'On main: before the merge | draft\x1f2026-10-10T21:00:00+02:00\x1e\n' +
      'WIP on feature/x: 1c7ad90 docs: initial\x1f2026-10-01T09:30:00+02:00\x1e';
    expect(parseStashList(out)).toEqual([
      { index: 0, message: 'On main: before the merge | draft', date: '2026-10-10T21:00:00+02:00' },
      { index: 1, message: 'WIP on feature/x: 1c7ad90 docs: initial', date: '2026-10-01T09:30:00+02:00' },
    ]);
    expect(parseStashList('')).toEqual([]);
  });
});

describe('mergeSourceFromMessage', () => {
  it('reads the merged branch from git\'s merge message', () => {
    expect(mergeSourceFromMessage("Merge branch 'feature/adr-0067'\n\n# Conflicts:\n")).toBe('feature/adr-0067');
    expect(mergeSourceFromMessage("Merge remote-tracking branch 'origin/main'")).toBe('origin/main');
    expect(mergeSourceFromMessage("Merge tag 'v1.2'")).toBe('v1.2');
  });

  it('returns null for a message it does not know', () => {
    expect(mergeSourceFromMessage('')).toBeNull();
    expect(mergeSourceFromMessage('Fix the build')).toBeNull();
  });
});

describe('parsePatch', () => {
  const patch = [
    'diff --git a/docs/risks.md b/docs/risks.md',
    'index 1c7ad90..3fa91c2 100644',
    '--- a/docs/risks.md',
    '+++ b/docs/risks.md',
    '@@ -3,4 +3,5 @@ 11.2 Technical debt',
    ' | ID | Item |',
    '-| TD-03 | Instance lock |',
    '+| TD-03 | Instance lock (dev) |',
    '+| TD-04 | Remote display spike |',
    '\\ No newline at end of file',
    ' | TD-05 | Terminology |',
    '',
  ].join('\n');

  it('drops the file header and sorts lines into hunk, add, del and context', () => {
    expect(parsePatch(patch)).toEqual([
      { kind: 'hunk', text: '@@ -3,4 +3,5 @@ 11.2 Technical debt' },
      { kind: 'context', text: '| ID | Item |' },
      { kind: 'del', text: '| TD-03 | Instance lock |' },
      { kind: 'add', text: '| TD-03 | Instance lock (dev) |' },
      { kind: 'add', text: '| TD-04 | Remote display spike |' },
      { kind: 'context', text: '| TD-05 | Terminology |' },
    ]);
  });

  it('does not take a "---" content line of a hunk for a header', () => {
    const out = '@@ -1,2 +1,1 @@\n----\n kept\n';
    expect(parsePatch(out)).toEqual([
      { kind: 'hunk', text: '@@ -1,2 +1,1 @@' },
      { kind: 'del', text: '---' },
      { kind: 'context', text: 'kept' },
    ]);
  });

  it('yields nothing for a binary file or an empty patch', () => {
    expect(parsePatch('')).toEqual([]);
    expect(parsePatch('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')).toEqual([]);
  });
});

describe('isCommitId', () => {
  it('accepts short and full hexadecimal ids and nothing git could read as an option', () => {
    expect(isCommitId('3fa91c2')).toBe(true);
    expect(isCommitId(A)).toBe(true);
    for (const bad of ['', 'abc', '--all', 'HEAD', 'main', 'abcd; rm', `${A}0`]) {
      expect(isCommitId(bad)).toBe(false);
    }
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
