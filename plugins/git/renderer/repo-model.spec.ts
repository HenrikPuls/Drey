import { describe, expect, it } from 'vitest';
import type { GitBranch, GitStatus, VaultGitState } from '../shared/status.js';
import {
  branchLabel,
  branchOptions,
  branchTooltip,
  commitBusyLabel,
  commitButtonLabel,
  counted,
  okVaults,
  patchLineText,
  pickCurrentVault,
  pullButtonLabel,
  pushButtonLabel,
  pushCommitButtonLabel,
  syncBadge,
  unsavedSubject,
  type OkVault,
} from './repo-model.js';

const STATUS: GitStatus = {
  branch: 'main',
  head: 'abc1234',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  conflicts: [],
};

function repo(vaultId: string, patch: Partial<OkVault> = {}, status: Partial<GitStatus> = {}): OkVault {
  return {
    vaultId,
    state: 'ok',
    root: `/repos/${vaultId}`,
    prefix: '',
    status: { ...STATUS, ...status },
    stagedOutside: 0,
    operation: null,
    fetchedAt: null,
    stashCount: 0,
    managedBy: null,
    ...patch,
  };
}

const plain = (vaultId: string): VaultGitState => ({ vaultId, state: 'not-a-repo' });

describe('pickCurrentVault', () => {
  it('follows the focused document into a repository', () => {
    expect(pickCurrentVault([repo('a'), repo('b')], 'a', 'b')).toBe('b');
  });

  it('keeps the shown repository when the focused vault is none', () => {
    expect(pickCurrentVault([repo('a'), plain('b')], 'a', 'b')).toBe('a');
    expect(pickCurrentVault([repo('a'), repo('b')], 'b', null)).toBe('b');
  });

  it('starts with the first repository, or the first vault when there is none', () => {
    expect(pickCurrentVault([plain('a'), repo('b')], null, null)).toBe('b');
    expect(pickCurrentVault([plain('a'), plain('b')], null, null)).toBe('a');
    expect(pickCurrentVault([], 'gone', null)).toBeNull();
  });

  it('leaves a vault that was removed or stopped being a repository', () => {
    expect(pickCurrentVault([repo('b')], 'a', null)).toBe('b');
    expect(pickCurrentVault([plain('a'), repo('b')], 'a', null)).toBe('b');
  });

  it('stays on a plain vault while no vault is a repository', () => {
    expect(pickCurrentVault([plain('a'), plain('b')], 'b', null)).toBe('b');
  });
});

describe('okVaults', () => {
  it('keeps only the repositories git could read', () => {
    const vaults: VaultGitState[] = [plain('a'), repo('b'), { vaultId: 'c', state: 'no-git' }];
    expect(okVaults(vaults).map((v) => v.vaultId)).toEqual(['b']);
  });
});

describe('wording', () => {
  it('counts with the right number', () => {
    expect(counted(1, 'commit')).toBe('1 commit');
    expect(counted(3, 'conflict')).toBe('3 conflicts');
  });

  it('names one unsaved tab and counts several', () => {
    expect(unsavedSubject([{ name: 'note.md' }])).toBe('"note.md" has');
    expect(unsavedSubject([{ name: 'a.md' }, { name: 'b.md' }])).toBe('2 tabs have');
  });

  it('labels a running commit by what it does', () => {
    expect(commitBusyLabel(false, false, false)).toBe('Committing…');
    expect(commitBusyLabel(false, false, true)).toBe('Committing and pushing…');
    expect(commitBusyLabel(false, true, false)).toBe('Amending…');
    expect(commitBusyLabel(true, false, true)).toBe('Completing the merge and pushing…');
  });

  it('labels the commit buttons for a merge, an amend and a plain commit', () => {
    expect(commitButtonLabel(true, false, 2)).toBe('Resolve all conflicts to complete the merge');
    expect(commitButtonLabel(true, false, 0)).toBe('Complete the merge (Ctrl+Enter)');
    expect(commitButtonLabel(false, true, 0)).toBe('Amend the last commit (Ctrl+Enter)');
    expect(commitButtonLabel(false, false, 0)).toBe('Commit staged changes (Ctrl+Enter)');
    expect(pushCommitButtonLabel(true, false)).toBe('Complete the merge and push (Ctrl+Shift+Enter)');
    expect(pushCommitButtonLabel(false, true)).toBe('Amend and push (Ctrl+Shift+Enter)');
    expect(pushCommitButtonLabel(false, false)).toBe('Commit and push (Ctrl+Shift+Enter)');
  });

  it('tells how far the branch is from its upstream', () => {
    expect(pullButtonLabel(0)).toBe('Pull');
    expect(pullButtonLabel(1)).toBe('Pull (1 commit to pull)');
    expect(pushButtonLabel(0)).toBe('Push');
    expect(pushButtonLabel(2)).toBe('Push (2 commits not pushed)');
    expect(syncBadge(0, 0)).toBe('');
    expect(syncBadge(2, 0)).toBe('↑2');
    expect(syncBadge(0, 3)).toBe('↓3');
    expect(syncBadge(2, 3)).toBe('↑2 ↓3');
  });

  it('shows the branch, a detached HEAD or an empty repository', () => {
    expect(branchLabel('main', 'abc1234')).toBe('main');
    expect(branchLabel(null, 'abc1234')).toBe('Detached at abc1234');
    expect(branchLabel(null, null)).toBe('No commits yet');
  });

  it('prints patch lines with their marker', () => {
    expect(patchLineText({ kind: 'add', text: 'new' })).toBe('+ new');
    expect(patchLineText({ kind: 'del', text: 'old' })).toBe('- old');
    expect(patchLineText({ kind: 'context', text: 'same' })).toBe('  same');
    expect(patchLineText({ kind: 'hunk', text: '@@ -1 +1 @@' })).toBe('@@ -1 +1 @@');
  });
});

describe('branchTooltip', () => {
  const when = (iso: string): string => `<${iso}>`;

  it('says what the branch tracks', () => {
    expect(branchTooltip(repo('a'), when)).toBe('Switch branch\nTracks origin/main');
    expect(branchTooltip(repo('a', {}, { upstream: null }), when)).toBe('Switch branch\nNot published yet');
  });

  it('adds the distance to the upstream and the last fetch', () => {
    const vault = repo('a', { fetchedAt: '2026-10-11T09:00:00Z' }, { ahead: 1, behind: 2 });
    expect(branchTooltip(vault, when).split('\n')).toEqual([
      'Switch branch',
      'Tracks origin/main',
      '1 commit not pushed, 2 to pull',
      'Last fetch <2026-10-11T09:00:00Z>',
    ]);
  });

  it('explains the disabled button during a merge', () => {
    const vault = repo('a', { operation: { kind: 'merge', source: 'feature' } });
    expect(branchTooltip(vault, when).split('\n')[0]).toBe('Switch branch (disabled while merging)');
  });
});

describe('branchOptions', () => {
  const branches: GitBranch[] = [
    { name: 'main', remote: false, current: true },
    { name: 'feature/docs', remote: false, current: false },
    { name: 'origin/main', remote: true, current: false },
  ];

  it('filters by a case-insensitive part of the name', () => {
    expect(branchOptions(branches, 'MAIN', 'merge')).toEqual([branches[2]]);
    // Branch names are case-sensitive: "MAIN" is a name no branch has.
    expect(branchOptions(branches, 'MAIN', 'switch')).toEqual([branches[0], branches[2], { create: 'MAIN' }]);
  });

  it('offers to create a typed name no branch has', () => {
    expect(branchOptions(branches, 'feature/new', 'switch')).toEqual([{ create: 'feature/new' }]);
    expect(branchOptions(branches, 'feature/docs', 'switch')).toEqual([branches[1]]);
  });

  it('does not offer a name git would refuse', () => {
    expect(branchOptions(branches, 'bad name', 'switch')).toEqual([]);
  });

  it('leaves the current branch and the create row out when merging', () => {
    expect(branchOptions(branches, '', 'merge')).toEqual([branches[1], branches[2]]);
    expect(branchOptions(branches, 'feature/new', 'merge')).toEqual([]);
  });
});
