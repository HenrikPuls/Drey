import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the spec stands in for the host, which owns the catalog at runtime
import { i18n } from '../../../shared/i18n';
import type { GitBranch, GitStatus, VaultGitState } from '../shared/status.js';
import {
  branchLabel,
  branchOptions,
  branchTooltip,
  changeTitle,
  commitButtonLabel,
  commitWhen,
  distanceText,
  keyOf,
  okVaults,
  patchLineText,
  pickCurrentRepo,
  pullButtonLabel,
  pushButtonLabel,
  pushCommitMenuLabel,
  repoLabel,
  syncBadge,
  syncText,
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
    subPath: '',
    discovered: false,
    ...patch,
  };
}

const plain = (vaultId: string): VaultGitState => ({ vaultId, state: 'not-a-repo' });

/** A repository the scan found under a parent vault (`p`). */
const found = (vaultId: string, subPath: string, patch: Partial<OkVault> = {}): OkVault =>
  repo(vaultId, { subPath, discovered: true, ...patch });

describe('pickCurrentRepo (ported from pickCurrentVault)', () => {
  it('follows the focused document into a repository', () => {
    expect(pickCurrentRepo([repo('a'), repo('b')], 'a', 'b')).toBe('b');
  });

  it('keeps the shown repository when the focused vault is none', () => {
    expect(pickCurrentRepo([repo('a'), plain('b')], 'a', 'b')).toBe('a');
    expect(pickCurrentRepo([repo('a'), repo('b')], 'b', null)).toBe('b');
  });

  it('starts with the first repository, or the first vault when there is none', () => {
    expect(pickCurrentRepo([plain('a'), repo('b')], null, null)).toBe('b');
    expect(pickCurrentRepo([plain('a'), plain('b')], null, null)).toBe('a');
    expect(pickCurrentRepo([], 'gone', null)).toBeNull();
  });

  it('leaves a vault that was removed or stopped being a repository', () => {
    expect(pickCurrentRepo([repo('b')], 'a', null)).toBe('b');
    expect(pickCurrentRepo([plain('a'), repo('b')], 'a', null)).toBe('b');
  });

  it('stays on a plain vault while no vault is a repository', () => {
    expect(pickCurrentRepo([plain('a'), plain('b')], 'b', null)).toBe('b');
  });
});

describe('pickCurrentRepo (found repositories, T-0045)', () => {
  const parent = 'p';

  it('prefers the found repository whose folder prefixes the focused document', () => {
    const states = [found(parent, 'drey'), found(parent, 'drey-tickets')];
    expect(pickCurrentRepo(states, null, parent, 'drey/src/a.ts')).toBe('p::drey');
    expect(pickCurrentRepo(states, null, parent, 'drey-tickets/tickets/T-0001.md')).toBe('p::drey-tickets');
    // A folder name that only starts like the path is not a prefix.
    expect(pickCurrentRepo([found(parent, 'drey')], null, parent, 'drey-old/x.md')).toBe('p::drey');
  });

  it('falls back to the vault\'s own repository, or the first found one', () => {
    expect(pickCurrentRepo([repo(parent), found(parent, 'drey')], null, parent, 'outside/readme.md')).toBe(parent);
    expect(pickCurrentRepo([plain(parent), found(parent, 'drey')], null, parent, null)).toBe('p::drey');
    expect(pickCurrentRepo([plain(parent), found(parent, 'a'), found(parent, 'b')], null, parent)).toBe('p::a');
  });

  it('keeps a selected found repository while it exists', () => {
    const states = [repo(parent), found(parent, 'drey')];
    expect(pickCurrentRepo(states, 'p::drey', null)).toBe('p::drey');
  });
});

describe('keyOf / repoLabel', () => {
  it('keys the own repository by the vault id, a found one by vault::folder', () => {
    expect(keyOf(repo('v1'))).toBe('v1');
    expect(keyOf(plain('v1'))).toBe('v1');
    expect(keyOf(found('v1', 'drey'))).toBe('v1::drey');
  });

  it('labels the own repository with the vault name, a found one with its folder', () => {
    expect(repoLabel(repo('v1'), 'Notes')).toBe('Notes');
    expect(repoLabel(repo('v1'), undefined)).toBe('v1');
    expect(repoLabel(found('v1', 'drey'), 'Notes')).toBe('drey');
    expect(repoLabel(found('v1', 'tools/drey'), 'Notes')).toBe('drey');
  });
});

describe('okVaults', () => {
  it('keeps only the repositories git could read', () => {
    const vaults: VaultGitState[] = [plain('a'), repo('b'), { vaultId: 'c', state: 'no-git' }];
    expect(okVaults(vaults).map((v) => v.vaultId)).toEqual(['b']);
  });
});

describe('wording', () => {
  it('labels the commit button for a merge, an amend and a plain commit', () => {
    expect(commitButtonLabel(i18n, true, false, 2)).toBe('Resolve all conflicts to complete the merge');
    expect(commitButtonLabel(i18n, true, false, 0)).toBe('Complete the merge (Ctrl+Enter)');
    expect(commitButtonLabel(i18n, false, true, 0)).toBe('Amend the last commit (Ctrl+Enter)');
    expect(commitButtonLabel(i18n, false, false, 0)).toBe('Commit staged changes (Ctrl+Enter)');
  });

  it('names the menu row of Ctrl+Shift+Enter by what it does', () => {
    expect(pushCommitMenuLabel(i18n, true, false)).toBe('Complete the merge and push');
    expect(pushCommitMenuLabel(i18n, false, true)).toBe('Amend and push');
    expect(pushCommitMenuLabel(i18n, false, false)).toBe('Commit and push');
  });

  it('tells how far the branch is from its upstream', () => {
    expect(pullButtonLabel(i18n, 0)).toBe('Pull');
    expect(pullButtonLabel(i18n, 1)).toBe('Pull (1 commit to pull)');
    expect(pushButtonLabel(i18n, 0)).toBe('Push');
    expect(pushButtonLabel(i18n, 2)).toBe('Push (2 commits not pushed)');
    expect(syncBadge(0, 0)).toBe('');
    expect(syncBadge(2, 0)).toBe('↑2');
    expect(syncBadge(0, 3)).toBe('↓3');
    expect(syncBadge(2, 3)).toBe('↑2 ↓3');
  });

  it('ends the branch line with the distance, or "Not published" for a branch without upstream', () => {
    expect(syncText(i18n, repo('a', {}, { ahead: 2, behind: 1 }))).toBe('↑2 ↓1');
    expect(syncText(i18n, repo('a'))).toBe('');
    expect(syncText(i18n, repo('a', {}, { upstream: null }))).toBe('Not published');
    expect(syncText(i18n, repo('a', {}, { upstream: null, branch: null }))).toBe('');
  });

  it('shows the branch, a detached HEAD or an empty repository', () => {
    expect(branchLabel(i18n, 'main', 'abc1234')).toBe('main');
    expect(branchLabel(i18n, null, 'abc1234')).toBe('Detached at abc1234');
    expect(branchLabel(i18n, null, null)).toBe('No commits yet');
  });

  it('titles a file row with its path and kind', () => {
    expect(changeTitle(i18n, 'projects/brand-guide.md', 'modified')).toBe('projects/brand-guide.md — Modified');
    expect(changeTitle(i18n, 'a.md', 'conflict')).toBe('a.md — Merge conflict');
  });

  it('dates a commit as the time today, yesterday, else the short date', () => {
    const now = new Date(2026, 10, 8, 15, 0);
    expect(commitWhen(i18n, new Date(2026, 10, 8, 10, 42).toISOString(), now)).toBe('10:42');
    expect(commitWhen(i18n, new Date(2026, 10, 7, 23, 0).toISOString(), now)).toBe('yesterday');
    expect(commitWhen(i18n, new Date(2026, 10, 5, 9, 0).toISOString(), now)).toBe('Nov 5');
    expect(commitWhen(i18n, 'not a date', now)).toBe('not a date');
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
    expect(branchTooltip(i18n, repo('a'), when)).toBe('Switch branch\nTracks origin/main');
    expect(branchTooltip(i18n, repo('a', {}, { upstream: null }), when)).toBe('Switch branch\nNot published yet');
  });

  it('adds the distance to the upstream and the last fetch', () => {
    const vault = repo('a', { fetchedAt: '2026-10-11T09:00:00Z' }, { ahead: 1, behind: 2 });
    expect(branchTooltip(i18n, vault, when).split('\n')).toEqual([
      'Switch branch',
      'Tracks origin/main',
      '1 commit not pushed, 2 to pull',
      'Last fetch <2026-10-11T09:00:00Z>',
    ]);
    expect(distanceText(i18n, 3, 0)).toBe('3 commits not pushed');
    expect(distanceText(i18n, 0, 4)).toBe('4 to pull');
  });

  it('explains the disabled button during a merge', () => {
    const vault = repo('a', { operation: { kind: 'merge', source: 'feature' } });
    expect(branchTooltip(i18n, vault, when).split('\n')[0]).toBe('Switch branch (disabled while merging)');
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
