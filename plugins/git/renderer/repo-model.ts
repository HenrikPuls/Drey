/**
 * The Source control panel's decisions and wording as pure functions:
 * which repository the panel shows, what the buttons say (through the
 * host's i18n facade, handed in), which rows the branch picker offers.
 * No DOM.
 */
import {
  isPlausibleBranchName,
  repoKey,
  type GitBranch,
  type GitChangeKind,
  type PatchLine,
  type VaultGitState,
} from '../shared/status.js';
import type { MessageKey } from '../../../shared/i18n';
import type { PluginI18nApi } from '../../../shared/plugin-api/renderer';

export type OkVault = Extract<VaultGitState, { state: 'ok' }>;

/** The three lists of the panel. */
export type Group = 'staged' | 'changes' | 'conflicts';

/** A row of the branch picker: an existing branch, or the offer to create one. */
export type BranchOption = GitBranch | { readonly create: string };

export function okVaults(vaults: readonly VaultGitState[]): OkVault[] {
  return vaults.filter((v): v is OkVault => v.state === 'ok');
}

/** The key one state entry is shown under: the vault id, or `vaultId::folder` for a found repository. */
export function keyOf(state: VaultGitState): string {
  return repoKey(state.vaultId, state.state === 'ok' ? state.subPath : '');
}

/** What the repository select shows: the vault's name for its own repository, the folder for a found one. */
export function repoLabel(repo: OkVault, vaultName: string | undefined): string {
  if (!repo.discovered) {
    return vaultName ?? repo.vaultId;
  }
  const slash = repo.subPath.lastIndexOf('/');
  return repo.subPath.slice(slash + 1);
}

/**
 * Which repository the panel shows, keyed like {@link keyOf}: the
 * focused document's repository when it lies in one — inside the
 * focused vault that is the vault's own repository, or the found one
 * whose folder prefixes the document's path — otherwise the one shown
 * so far while it still exists, otherwise the first repository.
 */
export function pickCurrentRepo(
  vaults: readonly VaultGitState[],
  current: string | null,
  activeVault: string | null,
  activeDocPath?: string | null,
): string | null {
  const repos = okVaults(vaults);
  if (activeVault !== null) {
    const own = repos.find((v) => v.vaultId === activeVault && v.subPath === '');
    const found = repos.filter((v) => v.vaultId === activeVault && v.discovered);
    if (own !== undefined || found.length > 0) {
      if (typeof activeDocPath === 'string' && activeDocPath !== '') {
        const inside = found
          .filter((v) => activeDocPath === v.subPath || activeDocPath.startsWith(`${v.subPath}/`))
          .sort((a, b) => b.subPath.length - a.subPath.length)[0];
        if (inside !== undefined) {
          return keyOf(inside);
        }
      }
      return own !== undefined ? keyOf(own) : keyOf(found[0]);
    }
  }
  if (current === null || !vaults.some((v) => keyOf(v) === current)) {
    return repos.length > 0 ? keyOf(repos[0]) : vaults.length > 0 ? keyOf(vaults[0]) : null;
  }
  if (repos.length > 0 && !repos.some((v) => keyOf(v) === current)) {
    return keyOf(repos[0]);
  }
  return current;
}

/** The commit field's check button: what Ctrl+Enter does right now. */
export function commitButtonLabel(i18n: PluginI18nApi, merging: boolean, amending: boolean, conflictsLeft: number): string {
  if (merging) {
    return i18n.t(conflictsLeft > 0 ? 'git.commit.resolve_first' : 'git.commit.complete_merge');
  }
  return i18n.t(amending ? 'git.commit.amend' : 'git.commit.commit');
}

/** The ⋯ menu's "Commit and push" row for a merge, an amend and a plain commit (Ctrl+Shift+Enter). */
export function pushCommitMenuLabel(i18n: PluginI18nApi, merging: boolean, amending: boolean): string {
  if (merging) {
    return i18n.t('git.menu.merge_push');
  }
  return i18n.t(amending ? 'git.menu.amend_push' : 'git.menu.commit_push');
}

export function pullButtonLabel(i18n: PluginI18nApi, behind: number): string {
  return behind > 0 ? i18n.t('git.pull.count', { count: behind }) : i18n.t('git.pull');
}

export function pushButtonLabel(i18n: PluginI18nApi, ahead: number): string {
  return ahead > 0 ? i18n.t('git.push.count', { count: ahead }) : i18n.t('git.push');
}

/** What the branch button shows: the branch, or where a detached HEAD sits. */
export function branchLabel(i18n: PluginI18nApi, branch: string | null, head: string | null): string {
  if (branch !== null) {
    return branch;
  }
  return head === null ? i18n.t('git.branch.no_commits') : i18n.t('git.branch.detached', { head });
}

/** `↑2 ↓1` next to the branch name; empty when the branch is in step. */
export function syncBadge(ahead: number, behind: number): string {
  return [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].join(' ').trim();
}

/**
 * The right end of the branch line (board 9d): `Not published` for a
 * branch with commits and no upstream, else the distance badge.
 */
export function syncText(i18n: PluginI18nApi, vault: OkVault): string {
  const { branch, head, upstream, ahead, behind } = vault.status;
  if (branch !== null && head !== null && upstream === null) {
    return i18n.t('git.branch.not_published');
  }
  return syncBadge(ahead, behind);
}

/** The distance to the upstream as one sentence; empty when in step. */
export function distanceText(i18n: PluginI18nApi, ahead: number, behind: number): string {
  if (ahead > 0 && behind > 0) {
    return i18n.t('git.branch.ahead_behind', { ahead, behind });
  }
  if (ahead > 0) {
    return i18n.t('git.branch.ahead', { ahead });
  }
  return behind > 0 ? i18n.t('git.branch.behind', { behind }) : '';
}

/** The branch button's tooltip, one fact per line. */
export function branchTooltip(i18n: PluginI18nApi, vault: OkVault, formatWhen: (iso: string) => string): string {
  const { ahead, behind, upstream } = vault.status;
  const lines = [i18n.t(vault.operation !== null ? 'git.branch.switch_merging' : 'git.branch.switch')];
  lines.push(upstream === null ? i18n.t('git.branch.not_published_yet') : i18n.t('git.branch.tracks', { upstream }));
  const distance = distanceText(i18n, ahead, behind);
  if (distance !== '') {
    lines.push(distance);
  }
  if (vault.fetchedAt !== null) {
    lines.push(i18n.t('git.branch.last_fetch', { when: formatWhen(vault.fetchedAt) }));
  }
  return lines.join('\n');
}

const KIND_KEYS: Readonly<Record<GitChangeKind, MessageKey>> = {
  modified: 'git.kind.modified',
  added: 'git.kind.added',
  renamed: 'git.kind.renamed',
  deleted: 'git.kind.deleted',
  untracked: 'git.kind.untracked',
  conflict: 'git.kind.conflict',
};

/** A file row's tooltip: `projects/brand-guide.md — Modified`. */
export function changeTitle(i18n: PluginI18nApi, path: string, kind: GitChangeKind): string {
  return i18n.t('git.row.title', { path, kind: i18n.t(KIND_KEYS[kind]) });
}

/**
 * When a commit was made, as a history row says it (board 9d): the time
 * for today, `yesterday`, else the short date (`Nov 5`). The raw text
 * when the date cannot be read.
 */
export function commitWhen(i18n: PluginI18nApi, iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) {
    return iso;
  }
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(when)) / 86_400_000);
  if (days === 0) {
    return i18n.formatTime(when);
  }
  if (days === 1) {
    return i18n.t('git.history.yesterday');
  }
  return new Intl.DateTimeFormat(i18n.locale, { month: 'short', day: 'numeric' }).format(when);
}

/**
 * The branch picker's rows for a typed filter. Merging leaves out the
 * current branch; switching offers to create the typed name when it is
 * a possible branch name no branch has yet.
 */
export function branchOptions(
  branches: readonly GitBranch[],
  query: string,
  mode: 'switch' | 'merge',
): BranchOption[] {
  const needle = query.toLowerCase();
  const options: BranchOption[] = branches.filter(
    (b) => b.name.toLowerCase().includes(needle) && !(mode === 'merge' && b.current),
  );
  if (mode === 'switch' && query !== '' && isPlausibleBranchName(query) && !branches.some((b) => b.name === query)) {
    options.push({ create: query });
  }
  return options;
}

/** A patch line as the history dialog prints it. */
export function patchLineText(line: PatchLine): string {
  const prefix = line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : line.kind === 'hunk' ? '' : '  ';
  return `${prefix}${line.text}`;
}
