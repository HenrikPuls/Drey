/**
 * The Source control panel's decisions and wording as pure functions:
 * which repository the panel shows, what the buttons say, which rows the
 * branch picker offers. No DOM, no plugin API.
 */
import {
  isPlausibleBranchName,
  type GitBranch,
  type PatchLine,
  type VaultGitState,
} from '../shared/status.js';

export type OkVault = Extract<VaultGitState, { state: 'ok' }>;

/** The three lists of the panel. */
export type Group = 'staged' | 'changes' | 'conflicts';

/** A row of the branch picker: an existing branch, or the offer to create one. */
export type BranchOption = GitBranch | { readonly create: string };

export function okVaults(vaults: readonly VaultGitState[]): OkVault[] {
  return vaults.filter((v): v is OkVault => v.state === 'ok');
}

/**
 * The vault whose repository the panel shows: the focused document's
 * vault when that is a repository, otherwise the one shown so far while
 * it still is one, otherwise the first repository.
 */
export function pickCurrentVault(
  vaults: readonly VaultGitState[],
  current: string | null,
  activeVault: string | null,
): string | null {
  const repos = okVaults(vaults);
  if (activeVault !== null && repos.some((v) => v.vaultId === activeVault)) {
    return activeVault;
  }
  if (current === null || !vaults.some((v) => v.vaultId === current)) {
    return repos[0]?.vaultId ?? vaults[0]?.vaultId ?? null;
  }
  if (repos.length > 0 && !repos.some((v) => v.vaultId === current)) {
    return repos[0].vaultId;
  }
  return current;
}

/** `1 commit`, `3 commits`. */
export function counted(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** The subject of an unsaved-tabs sentence: `"note.md" has` / `3 tabs have`. */
export function unsavedSubject(dirty: ReadonlyArray<{ readonly name: string }>): string {
  return dirty.length === 1 ? `"${dirty[0].name}" has` : `${dirty.length} tabs have`;
}

/** The busy line of a running commit. */
export function commitBusyLabel(merging: boolean, amend: boolean, push: boolean): string {
  if (merging) {
    return push ? 'Completing the merge and pushing…' : 'Completing the merge…';
  }
  if (amend) {
    return push ? 'Amending and pushing…' : 'Amending…';
  }
  return push ? 'Committing and pushing…' : 'Committing…';
}

export function commitButtonLabel(merging: boolean, amending: boolean, conflictsLeft: number): string {
  if (merging) {
    return conflictsLeft > 0 ? 'Resolve all conflicts to complete the merge' : 'Complete the merge (Ctrl+Enter)';
  }
  return amending ? 'Amend the last commit (Ctrl+Enter)' : 'Commit staged changes (Ctrl+Enter)';
}

export function pushCommitButtonLabel(merging: boolean, amending: boolean): string {
  if (merging) {
    return 'Complete the merge and push (Ctrl+Shift+Enter)';
  }
  return amending ? 'Amend and push (Ctrl+Shift+Enter)' : 'Commit and push (Ctrl+Shift+Enter)';
}

export function pullButtonLabel(behind: number): string {
  return behind > 0 ? `Pull (${counted(behind, 'commit')} to pull)` : 'Pull';
}

export function pushButtonLabel(ahead: number): string {
  return ahead > 0 ? `Push (${counted(ahead, 'commit')} not pushed)` : 'Push';
}

/** What the branch button shows: the branch, or where a detached HEAD sits. */
export function branchLabel(branch: string | null, head: string | null): string {
  return branch ?? (head === null ? 'No commits yet' : `Detached at ${head}`);
}

/** `↑2 ↓1` next to the branch name; empty when the branch is in step. */
export function syncBadge(ahead: number, behind: number): string {
  return [ahead > 0 ? `↑${ahead}` : '', behind > 0 ? `↓${behind}` : ''].join(' ').trim();
}

/** The branch button's tooltip, one fact per line. */
export function branchTooltip(vault: OkVault, formatWhen: (iso: string) => string): string {
  const { ahead, behind, upstream } = vault.status;
  const lines = [vault.operation !== null ? 'Switch branch (disabled while merging)' : 'Switch branch'];
  lines.push(upstream === null ? 'Not published yet' : `Tracks ${upstream}`);
  if (ahead > 0 || behind > 0) {
    lines.push(
      [ahead > 0 ? `${counted(ahead, 'commit')} not pushed` : '', behind > 0 ? `${behind} to pull` : '']
        .filter((part) => part !== '')
        .join(', '),
    );
  }
  if (vault.fetchedAt !== null) {
    lines.push(`Last fetch ${formatWhen(vault.fetchedAt)}`);
  }
  return lines.join('\n');
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
