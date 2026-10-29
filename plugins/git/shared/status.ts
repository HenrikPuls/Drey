/**
 * The git plugin's pure half: the shapes both sides share, the parsers for
 * what `git` prints, and the mapping between repository paths and vault
 * paths. No Node, no DOM -- the main entry runs git and feeds these, the
 * renderer bundles the same file.
 *
 * A vault is the repository root OR a folder inside it (a `docs/` folder
 * of a code repository): `prefix` is that folder's path inside the
 * repository with a trailing slash, `''` for the root.
 */

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';

export interface GitChange {
  /** Vault-relative path, forward slashes. */
  readonly path: string;
  readonly kind: GitChangeKind;
  /** Vault-relative path before a rename, when it lies inside the vault. */
  readonly origPath?: string;
}

export interface GitStatus {
  /** Current branch, or `null` on a detached HEAD. */
  readonly branch: string | null;
  /** Abbreviated commit of HEAD; `null` in a repository without commits. */
  readonly head: string | null;
  /** The branch's upstream (`origin/main`), or `null` when it has none. */
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: readonly GitChange[];
  /** Working-tree changes not staged yet, untracked files included. */
  readonly unstaged: readonly GitChange[];
  readonly conflicts: readonly GitChange[];
}

/**
 * A multi-step operation git is in the middle of. Only a merge is
 * supported (ADR-0065 later change); `source` is what is being merged in
 * (`feature/x`), `null` when the message cannot be read.
 */
export interface GitOperation {
  readonly kind: 'merge';
  readonly source: string | null;
}

/** What the panel knows about one vault. */
export type VaultGitState =
  | { readonly vaultId: string; readonly state: 'no-git' }
  | { readonly vaultId: string; readonly state: 'not-a-repo' }
  | {
      readonly vaultId: string;
      readonly state: 'ok';
      /** Absolute path of the repository root. */
      readonly root: string;
      readonly prefix: string;
      readonly status: GitStatus;
      /** Staged changes outside the vault folder -- a commit takes them along. */
      readonly stagedOutside: number;
      /** The merge in progress, or `null`. */
      readonly operation: GitOperation | null;
      /** ISO time of the last fetch / pull (`FETCH_HEAD`), `null` if never. */
      readonly fetchedAt: string | null;
      /** Number of stashes in the repository. */
      readonly stashCount: number;
      /**
       * The plugin that structurally manages this vault (SDK 1.32),
       * `null` for an ordinary repository: everything stays visible,
       * stage/commit/amend/discard/pull/push are refused with the
       * manager's name.
       */
      readonly managedBy: string | null;
      /**
       * Which repository under the vault this entry reports (T-0045):
       * `''` = the vault's own repository at or around the vault root; a
       * forward-slash folder path = a repository the scan found below a
       * vault that is no repository itself.
       */
      readonly subPath: string;
      /** True when the scan found this repository under a parent vault — read-only in the panel. */
      readonly discovered: boolean;
    };

export interface GitBranch {
  /** `main`, or `origin/main` for a remote branch. */
  readonly name: string;
  readonly remote: boolean;
  readonly current: boolean;
}

export interface GitLogEntry {
  readonly hash: string;
  readonly author: string;
  /** ISO 8601 author date. */
  readonly date: string;
  readonly subject: string;
  /** Full commit id; absent when the log was read without it. */
  readonly id?: string;
  /** True for a commit that is not on the upstream yet (set by main). */
  readonly unpushed?: boolean;
}

/** One entry of `git stash list`. */
export interface GitStash {
  /** Position in the list; `stash@{index}`. */
  readonly index: number;
  /** git's own description (`On main: my note`, `WIP on main: abc subject`). */
  readonly message: string;
  /** ISO 8601 date the stash was made. */
  readonly date: string;
}

/** One line of a unified diff, headers already dropped. */
export interface PatchLine {
  readonly kind: 'hunk' | 'add' | 'del' | 'context';
  readonly text: string;
}

/** The decoration one change draws in the Files panel. */
export interface ChangeDecoration {
  readonly path: string;
  readonly badge: string;
  readonly tone: 'modified' | 'added' | 'untracked' | 'conflict' | 'deleted';
  readonly tooltip: string;
}

/** A repository path as a vault path, or `null` when it lies outside the vault. */
export function toVaultPath(repoPath: string, prefix: string): string | null {
  if (prefix === '') {
    return repoPath;
  }
  return repoPath.startsWith(prefix) && repoPath.length > prefix.length
    ? repoPath.slice(prefix.length)
    : null;
}

export function toRepoPath(vaultPath: string, prefix: string): string {
  return `${prefix}${vaultPath}`;
}

/**
 * A discovered repository's path (relative to ITS root) as a vault path:
 * the scan folder is what sits inside the vault. `subPath: ''` (the
 * vault's own repository) passes through.
 */
export function intoVaultPath(repoPath: string, subPath: string): string {
  return subPath === '' ? repoPath : `${subPath}/${repoPath}`;
}

/**
 * A vault path of a discovered repository back to that repository's own
 * path — the inverse of {@link intoVaultPath}. A path without the
 * prefix passes through unchanged (the panel only sends the current
 * repository's paths).
 */
export function intoRepoPath(vaultPath: string, subPath: string): string {
  return subPath !== '' && vaultPath.startsWith(`${subPath}/`)
    ? vaultPath.slice(subPath.length + 1)
    : vaultPath;
}

/**
 * Re-maps every change of a discovered repository's status (parsed with
 * `parseStatus(out, '')`, so repository-relative) into vault-relative
 * paths — what the renderer, `ctx.vault.read` and the decorations seam
 * expect. `subPath: ''` returns the status as it is.
 */
export function prefixStatusPaths(status: GitStatus, subPath: string): GitStatus {
  if (subPath === '') {
    return status;
  }
  const move = (change: GitChange): GitChange => ({
    ...change,
    path: intoVaultPath(change.path, subPath),
    ...(change.origPath !== undefined ? { origPath: intoVaultPath(change.origPath, subPath) } : {}),
  });
  return {
    ...status,
    staged: status.staged.map(move),
    unstaged: status.unstaged.map(move),
    conflicts: status.conflicts.map(move),
  };
}

/**
 * The key one repository entry is addressed by (T-0045): the vault id
 * for the vault's own repository, `vaultId::subPath` for a discovered
 * one. Both sides (main's command bookkeeping, the panel's state) key
 * by this, so they share it here.
 */
export function repoKey(vaultId: string, subPath: string): string {
  return subPath === '' ? vaultId : `${vaultId}::${subPath}`;
}

function kindOf(code: string): GitChangeKind | null {
  switch (code) {
    case 'M':
    case 'T':
      return 'modified';
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return null;
  }
}

/**
 * Parses `git status --porcelain=v2 -z --branch`. Records are NUL-separated;
 * a rename record (`2 …`) is followed by one more field, its original path.
 * Paths are repository-relative in git's output and vault-relative in the
 * result; entries outside the vault are dropped.
 */
export function parseStatus(output: string, prefix: string): GitStatus {
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  const conflicts: GitChange[] = [];

  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record === '') {
      continue;
    }
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') {
        branch = value === '(detached)' ? null : value;
      } else if (key === 'branch.oid') {
        head = value === '(initial)' ? null : value.slice(0, 7);
      } else if (key === 'branch.upstream') {
        upstream = value;
      } else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }

    const type = record[0];
    if (type === '?') {
      const path = toVaultPath(record.slice(2), prefix);
      if (path !== null) {
        unstaged.push({ path, kind: 'untracked' });
      }
      continue;
    }
    if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const path = toVaultPath(afterFields(record, 10), prefix);
      if (path !== null) {
        conflicts.push({ path, kind: 'conflict' });
      }
      continue;
    }
    if (type !== '1' && type !== '2') {
      continue; // ignored files (`!`) and anything a newer git adds
    }

    // 1 XY sub mH mI mW hH hI path
    // 2 XY sub mH mI mW hH hI Xscore path <NUL> origPath
    const xy = record.slice(2, 4);
    const path = toVaultPath(afterFields(record, type === '1' ? 8 : 9), prefix);
    let origPath: string | null = null;
    if (type === '2') {
      i++;
      origPath = toVaultPath(fields[i] ?? '', prefix);
    }
    if (path === null) {
      continue;
    }
    const indexKind = kindOf(xy[0]);
    if (indexKind !== null) {
      staged.push({
        path,
        kind: indexKind,
        ...(indexKind === 'renamed' && origPath !== null ? { origPath } : {}),
      });
    }
    const treeKind = kindOf(xy[1]);
    if (treeKind !== null) {
      unstaged.push({ path, kind: treeKind });
    }
  }

  return { branch, head, upstream, ahead, behind, staged, unstaged, conflicts };
}

/** Everything after the first `count` space-separated fields (a path may hold spaces). */
function afterFields(record: string, count: number): string {
  let at = 0;
  for (let n = 0; n < count; n++) {
    const next = record.indexOf(' ', at);
    if (next < 0) {
      return '';
    }
    at = next + 1;
  }
  return record.slice(at);
}

const BADGES: Readonly<Record<GitChangeKind, { badge: string; tone: ChangeDecoration['tone']; label: string }>> = {
  modified: { badge: 'M', tone: 'modified', label: 'Modified' },
  added: { badge: 'A', tone: 'added', label: 'Added' },
  renamed: { badge: 'R', tone: 'added', label: 'Renamed' },
  deleted: { badge: 'D', tone: 'deleted', label: 'Deleted' },
  untracked: { badge: 'U', tone: 'untracked', label: 'Untracked' },
  conflict: { badge: '!', tone: 'conflict', label: 'Merge conflict' },
};

/** Badge letter and tooltip word of one change kind (the panel rows use it too). */
export function describeKind(kind: GitChangeKind): { badge: string; tone: ChangeDecoration['tone']; label: string } {
  return BADGES[kind];
}

/**
 * One decoration per changed path. A path can be staged AND changed again:
 * the working-tree state wins over the staged one, a conflict over both --
 * the tree shows what the file on disk is like right now.
 */
export function decorationsFor(status: GitStatus): ChangeDecoration[] {
  const byPath = new Map<string, ChangeDecoration>();
  const put = (change: GitChange, staged: boolean): void => {
    const { badge, tone, label } = BADGES[change.kind];
    byPath.set(change.path, {
      path: change.path,
      badge,
      tone,
      tooltip: staged ? `${label}, staged` : label,
    });
  };
  for (const change of status.staged) {
    put(change, true);
  }
  for (const change of status.unstaged) {
    put(change, false);
  }
  for (const change of status.conflicts) {
    put(change, false);
  }
  return [...byPath.values()];
}

/** How many files differ from the last commit (a file staged and changed again counts once). */
export function changeCount(status: GitStatus): number {
  return new Set([...status.staged, ...status.unstaged, ...status.conflicts].map((c) => c.path)).size;
}

/** The field / record separators `LOG_FORMAT` puts into `git log` output. */
const FIELD = '\x1f';
const RECORD = '\x1e';

/** `git log --pretty=format:` argument matching {@link parseLog}. */
export const LOG_FORMAT = '%h%x1f%an%x1f%aI%x1f%s%x1f%H%x1e';

export function parseLog(output: string): GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  for (const record of output.split(RECORD)) {
    const [hash, author, date, subject, id] = record.replace(/^\s+/, '').split(FIELD);
    if (hash && author !== undefined && date !== undefined && subject !== undefined) {
      entries.push({ hash, author, date, subject, ...(id ? { id } : {}) });
    }
  }
  return entries;
}

/** `git for-each-ref --format=` argument matching {@link parseBranches}. */
export const BRANCH_FORMAT = '%(refname)%1f%(refname:short)%1f%(HEAD)';

/** Local branches first (current on top), then remote branches without a local twin. */
export function parseBranches(output: string): GitBranch[] {
  const local: GitBranch[] = [];
  const remote: GitBranch[] = [];
  for (const line of output.split('\n')) {
    const [ref, name, marker] = line.trim().split(FIELD);
    if (!ref || !name) {
      continue;
    }
    if (ref.startsWith('refs/heads/')) {
      local.push({ name, remote: false, current: marker === '*' });
    } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
      remote.push({ name, remote: true, current: false });
    }
  }
  const localNames = new Set(local.map((b) => b.name));
  local.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
  remote.sort((a, b) => a.name.localeCompare(b.name));
  return [...local, ...remote.filter((b) => !localNames.has(b.name.slice(b.name.indexOf('/') + 1)))];
}

/**
 * Parses `git diff --name-status -z --no-renames --relative`: which vault
 * files a checkout / pull rewrote, and which it removed.
 */
export function parseNameStatus(output: string): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  const fields = output.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i + 1];
    if (path === '') {
      continue;
    }
    if (fields[i].startsWith('D')) {
      deleted.push(path);
    } else {
      changed.push(path);
    }
  }
  return { changed, deleted };
}

/** `git stash list --format=` argument matching {@link parseStashList}. */
export const STASH_FORMAT = '%gs%x1f%aI%x1e';

/** The stash list, newest first (index 0 is `stash@{0}`). */
export function parseStashList(output: string): GitStash[] {
  const stashes: GitStash[] = [];
  for (const record of output.split(RECORD)) {
    const [message, date] = record.replace(/^\s+/, '').split(FIELD);
    if (message && date !== undefined) {
      stashes.push({ index: stashes.length, message, date });
    }
  }
  return stashes;
}

/**
 * Reads what a merge brings in from git's `MERGE_MSG` (`Merge branch
 * 'feature/x'`, `Merge remote-tracking branch 'origin/x'`, `Merge tag 'v1'`).
 */
export function mergeSourceFromMessage(message: string): string | null {
  const match = /^Merge (?:remote-tracking )?(?:branch|tag|commit) '([^']+)'/.exec(message.trimStart());
  return match ? match[1] : null;
}

/**
 * Turns `git show --format= -p` output for ONE file into diff lines: the
 * `diff --git` / `index` / `---` / `+++` header is dropped, `\ No newline`
 * markers too. A binary file yields no lines.
 */
export function parsePatch(output: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let inHunk = false;
  for (const raw of output.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('@@')) {
      inHunk = true;
      lines.push({ kind: 'hunk', text: raw });
    } else if (!inHunk || raw.startsWith('\\')) {
      continue;
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1) });
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1) });
    }
  }
  return lines;
}

/** A commit id as the panel sends it: hexadecimal, 4 to 40 characters. */
export function isCommitId(value: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(value);
}

/** A branch name git would accept and that cannot be read as an option. */
export function isPlausibleBranchName(name: string): boolean {
  return (
    name !== '' &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)
  );
}
