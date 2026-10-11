import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  STASH_FORMAT,
  isCommitId,
  isPlausibleBranchName,
  mergeSourceFromMessage,
  parseBranches,
  parseLog,
  parseNameStatus,
  parseStashList,
  parseStatus,
  toRepoPath,
  type GitBranch,
  type GitLogEntry,
  type GitOperation,
  type GitStash,
  type VaultGitState,
} from '../shared/status';
import { GitError, GitRunner } from './git-runner';

/**
 * The Git plugin's main entry (milestone 65, ADR-0065): which registered
 * vaults live in a Git repository, their status, and the commands the
 * Source control panel runs. Everything goes through the installed `git`
 * (`GitRunner`); this file sequences the calls and tells the app when a
 * command rewrote the working tree (`ctx.vault.announceChanges`).
 *
 * A vault is the repository root or a folder inside it. Status, "stage
 * all" and the change lists are limited to the vault folder; a commit is
 * git's commit -- it takes whatever is staged, which is why the state
 * reports `stagedOutside`.
 */

/** Where a vault sits in its repository. */
interface Repo {
  /** Absolute repository root. */
  readonly root: string;
  /** The vault folder inside the repository, trailing slash; `''` for the root. */
  readonly prefix: string;
  /** Absolute vault folder -- the cwd of every vault-scoped command. */
  readonly cwd: string;
  /** Absolute git directory (`.git`, or the worktree's own) -- where `MERGE_HEAD` lives. */
  readonly gitDir: string;
}

type Located = { kind: 'repo'; repo: Repo } | { kind: 'none'; detail?: string } | { kind: 'no-git' };

const REFRESH_DEBOUNCE_MS = 250;
const LOG_LIMIT = 50;
const FILE_LOG_LIMIT = 100;

function vaultIdOf(payload: unknown): string {
  const id = (payload as { vaultId?: unknown } | null)?.vaultId;
  if (typeof id !== 'string' || id === '') {
    throw new Error('No vault given.');
  }
  return id;
}

function stringOf(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : '';
}

function stashRef(payload: unknown): string {
  const index = (payload as { index?: unknown } | null)?.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new Error('No stash given.');
  }
  return `stash@{${index}}`;
}

function pathsOf(payload: unknown): string[] {
  const paths = (payload as { paths?: unknown } | null)?.paths;
  return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && p !== '') : [];
}

const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    let gitPath = ((await ctx.config.get<string>('gitPath')) ?? '').trim();
    const git = new GitRunner(() => (gitPath === '' ? 'git' : gitPath));

    const located = new Map<string, Located>();
    const states = new Map<string, VaultGitState>();
    const running = new Map<string, AbortController>();

    const locate = async (vaultId: string): Promise<Located> => {
      const cached = located.get(vaultId);
      if (cached !== undefined) {
        return cached;
      }
      const vault = (await ctx.vault.listVaults()).find((v) => v.id === vaultId);
      let result: Located;
      if (vault === undefined || !vault.exists) {
        result = { kind: 'none' };
      } else {
        try {
          const out = await git.run(
            vault.path,
            ['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir'],
            { readOnly: true },
          );
          const [root = '', prefix = '', gitDir = ''] = out.split(/\r?\n/);
          result = { kind: 'repo', repo: { root, prefix, cwd: vault.path, gitDir } };
        } catch (error) {
          if (error instanceof GitError && error.kind === 'not-found') {
            result = { kind: 'no-git' };
          } else {
            const message = error instanceof Error ? error.message : String(error);
            // "Not a repository" is the ordinary case and needs no detail;
            // anything else (dubious ownership, a broken repository) does.
            result = /not a git repository/i.test(message) ? { kind: 'none' } : { kind: 'none', detail: message };
          }
        }
      }
      located.set(vaultId, result);
      return result;
    };

    /** The vault's repository, or a throw the panel shows as it is. */
    const repoOf = async (vaultId: string): Promise<Repo> => {
      const found = await locate(vaultId);
      if (found.kind === 'no-git') {
        throw new Error('git was not found. Install Git or set its path in Settings.');
      }
      if (found.kind === 'none') {
        throw new Error(found.detail ?? 'This vault is not a Git repository.');
      }
      return found.repo;
    };

    /** The merge in progress (`MERGE_HEAD` exists), with what is merged in. */
    const readOperation = async (repo: Repo): Promise<GitOperation | null> => {
      try {
        await access(join(repo.gitDir, 'MERGE_HEAD'));
      } catch {
        return null;
      }
      const message = await readFile(join(repo.gitDir, 'MERGE_MSG'), 'utf8').catch(() => '');
      return { kind: 'merge', source: mergeSourceFromMessage(message) };
    };

    const readFetchedAt = async (repo: Repo): Promise<string | null> => {
      try {
        return (await stat(join(repo.gitDir, 'FETCH_HEAD'))).mtime.toISOString();
      } catch {
        return null;
      }
    };

    const countStashes = async (repo: Repo): Promise<number> => {
      try {
        const out = await git.run(repo.root, ['stash', 'list', '--format=%gd'], { readOnly: true });
        return out.split(/\r?\n/).filter((l) => l !== '').length;
      } catch {
        return 0;
      }
    };

    const computeState = async (vaultId: string): Promise<VaultGitState> => {
      const found = await locate(vaultId);
      if (found.kind === 'no-git') {
        return { vaultId, state: 'no-git' };
      }
      if (found.kind === 'none') {
        return { vaultId, state: 'not-a-repo' };
      }
      const { repo } = found;
      const out = await git.run(
        repo.cwd,
        ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', '.'],
        { readOnly: true },
        repo.root,
      );
      const status = parseStatus(out, repo.prefix);
      let stagedOutside = 0;
      if (repo.prefix !== '') {
        const all = await git.run(repo.root, ['diff', '--cached', '--name-only', '-z'], { readOnly: true });
        const total = all.split('\0').filter((p) => p !== '').length;
        stagedOutside = Math.max(0, total - status.staged.length);
      }
      const [operation, fetchedAt, stashCount] = await Promise.all([
        readOperation(repo),
        readFetchedAt(repo),
        countStashes(repo),
      ]);
      return {
        vaultId,
        state: 'ok',
        root: repo.root,
        prefix: repo.prefix,
        status,
        stagedOutside,
        operation,
        fetchedAt,
        stashCount,
      };
    };

    /** Recomputes every vault's (or one vault's) state and pushes the full list. */
    const refreshNow = async (only?: string): Promise<VaultGitState[]> => {
      const vaults = await ctx.vault.listVaults();
      const registered = new Set(vaults.map((v) => v.id));
      for (const id of [...states.keys()]) {
        if (!registered.has(id)) {
          states.delete(id);
          located.delete(id);
        }
      }
      const targets = only !== undefined && registered.has(only) ? [only] : vaults.map((v) => v.id);
      await Promise.all(
        targets.map(async (id) => {
          try {
            states.set(id, await computeState(id));
          } catch (error) {
            ctx.log(`status of vault ${id} failed: ${String(error)}`, 'warn');
            states.set(id, { vaultId: id, state: 'not-a-repo' });
          }
        }),
      );
      const list = vaults.map((v) => states.get(v.id)).filter((s): s is VaultGitState => s !== undefined);
      ctx.ipc.emit('status-updated', list);
      return list;
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingAll = false;
    const pendingVaults = new Set<string>();
    const scheduleRefresh = (vaultId?: string): void => {
      if (vaultId === undefined) {
        pendingAll = true;
      } else {
        pendingVaults.add(vaultId);
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        const all = pendingAll || pendingVaults.size !== 1;
        const [single] = [...pendingVaults];
        pendingAll = false;
        pendingVaults.clear();
        void refreshNow(all ? undefined : single).catch(() => undefined);
      }, REFRESH_DEBOUNCE_MS);
    };

    ctx.app.onWillQuit(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      for (const controller of running.values()) {
        controller.abort();
      }
    });

    ctx.save.onNoteSaved((event) => {
      scheduleRefresh(event.vaultId);
    });

    ctx.vault.onChanged((event) => {
      // A round without a path can be a registry change or a folder that
      // became a repository in the meantime: look again where the vault sits.
      if (event.path === undefined) {
        if (event.vaultId === undefined) {
          located.clear();
        } else {
          located.delete(event.vaultId);
        }
      }
      scheduleRefresh(event.vaultId);
    });

    /**
     * Which vault files differ between two commits -- what a checkout or a
     * pull rewrote on disk, for the announcement round.
     */
    const announceBetween = async (vaultId: string, repo: Repo, from: string, to: string): Promise<void> => {
      if (from === to) {
        return;
      }
      try {
        const out = await git.run(
          repo.cwd,
          ['diff', '--name-status', '-z', '--no-renames', '--relative', from, to],
          { readOnly: true },
          repo.root,
        );
        const { changed, deleted } = parseNameStatus(out);
        ctx.vault.announceChanges({ vaultId, changedPaths: changed, deletedPaths: deleted });
      } catch {
        ctx.vault.announceChanges({ vaultId });
      }
    };

    const headOf = (repo: Repo): Promise<string> =>
      git
        .run(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { readOnly: true })
        .then((out) => out.trim())
        .catch(() => '');

    /** Runs a command the user can cancel; one at a time per vault. */
    const cancellable = async <T>(vaultId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      if (running.has(vaultId)) {
        throw new Error('Another Git command is still running for this vault.');
      }
      const controller = new AbortController();
      running.set(vaultId, controller);
      try {
        return await work(controller.signal);
      } finally {
        running.delete(vaultId);
      }
    };

    // -- queries -----------------------------------------------------------

    ctx.ipc.handle('status', async (payload) => {
      const request = payload as { refresh?: unknown; relocate?: unknown } | null;
      const refresh = request?.refresh === true;
      if (request?.relocate === true) {
        located.clear();
      }
      if (refresh || states.size === 0) {
        return refreshNow();
      }
      const vaults = await ctx.vault.listVaults();
      return vaults.map((v) => states.get(v.id)).filter((s): s is VaultGitState => s !== undefined);
    });

    ctx.ipc.handle('branches', async (payload): Promise<GitBranch[]> => {
      const repo = await repoOf(vaultIdOf(payload));
      const out = await git.run(
        repo.root,
        ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'],
        { readOnly: true },
      );
      return parseBranches(out);
    });

    /** Commits HEAD has that no remote has: what a push would send. */
    const unpushedIds = async (repo: Repo, upstream: string | null): Promise<Set<string>> => {
      try {
        let args: string[];
        if (upstream !== null) {
          args = ['rev-list', `${upstream}..HEAD`];
        } else {
          // Never published: everything counts, but only if there is a remote at all.
          const remotes = await git.run(repo.root, ['remote'], { readOnly: true });
          if (remotes.trim() === '') {
            return new Set();
          }
          args = ['rev-list', 'HEAD', '--not', '--remotes'];
        }
        const out = await git.run(repo.root, args, { readOnly: true });
        return new Set(out.split(/\r?\n/).filter((l) => l !== ''));
      } catch {
        return new Set();
      }
    };

    ctx.ipc.handle('log', async (payload): Promise<GitLogEntry[]> => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      if ((await headOf(repo)) === '') {
        return []; // a repository without commits has no log
      }
      const out = await git.run(
        repo.root,
        ['log', '-n', String(LOG_LIMIT), `--pretty=format:${LOG_FORMAT}`],
        { readOnly: true },
      );
      const known = states.get(vaultId);
      const unpushed = await unpushedIds(repo, known?.state === 'ok' ? known.status.upstream : null);
      return parseLog(out).map((entry) =>
        entry.id !== undefined && unpushed.has(entry.id) ? { ...entry, unpushed: true } : entry,
      );
    });

    /** The commits that changed one file, newest first (renames end the list). */
    ctx.ipc.handle('fileLog', async (payload): Promise<GitLogEntry[]> => {
      const repo = await repoOf(vaultIdOf(payload));
      const path = stringOf(payload, 'path');
      if (path === '') {
        throw new Error('No file given.');
      }
      if ((await headOf(repo)) === '') {
        return [];
      }
      const out = await git.run(
        repo.root,
        ['log', '-n', String(FILE_LOG_LIMIT), `--pretty=format:${LOG_FORMAT}`, '--', toRepoPath(path, repo.prefix)],
        { readOnly: true },
      );
      return parseLog(out);
    });

    /** What one commit did to one file, as git's unified diff (the panel parses it). */
    ctx.ipc.handle('filePatch', async (payload): Promise<string> => {
      const repo = await repoOf(vaultIdOf(payload));
      const path = stringOf(payload, 'path');
      const hash = stringOf(payload, 'hash');
      if (path === '' || !isCommitId(hash)) {
        throw new Error('No file or commit given.');
      }
      return git.run(
        repo.root,
        ['show', '--format=', '--no-color', '--no-ext-diff', '--unified=3', hash, '--', toRepoPath(path, repo.prefix)],
        { readOnly: true },
      );
    });

    /** The message of the last commit -- what "Amend" starts from. */
    ctx.ipc.handle('headMessage', async (payload): Promise<string> => {
      const repo = await repoOf(vaultIdOf(payload));
      if ((await headOf(repo)) === '') {
        return '';
      }
      return (await git.run(repo.root, ['log', '-1', '--format=%B'], { readOnly: true })).trim();
    });

    /**
     * One side of a comparison: the file in the last commit (`head`), in
     * the index (`index`) or on disk (`worktree`). `content: null` = the
     * file does not exist there; `binary` = not text, no diff.
     */
    ctx.ipc.handle('fileAt', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const request = payload as { path?: unknown; rev?: unknown };
      const path = typeof request.path === 'string' ? request.path : '';
      if (path === '') {
        throw new Error('No file given.');
      }
      let content: string | null;
      if (request.rev === 'worktree') {
        content = await ctx.vault.read(path, { vaultId }).catch(() => null);
      } else {
        const repo = await repoOf(vaultId);
        const rev = request.rev;
        // 'head' = the last commit, a hex id = that commit, anything else = the index.
        const treeish = rev === 'head' ? 'HEAD' : typeof rev === 'string' && isCommitId(rev) ? rev : '';
        const spec = `${treeish}:${toRepoPath(path, repo.prefix)}`;
        content = await git.run(repo.root, ['show', spec], { readOnly: true }).catch(() => null);
      }
      if (content !== null && content.includes('\0')) {
        return { content: null, binary: true };
      }
      return { content: content === null ? null : content.replace(/\r\n/g, '\n'), binary: false };
    });

    // -- index -------------------------------------------------------------

    ctx.ipc.handle('stage', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const paths = pathsOf(payload);
      // `-A` so a deleted file is staged as a deletion; no paths = the vault.
      await git.run(repo.cwd, ['add', '-A', '--', ...(paths.length > 0 ? paths : ['.'])], {}, repo.root);
      return refreshNow(vaultId);
    });

    ctx.ipc.handle('unstage', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const paths = pathsOf(payload);
      const targets = paths.length > 0 ? paths : ['.'];
      if ((await headOf(repo)) === '') {
        // No commit to restore from yet: take the files out of the index.
        await git.run(repo.cwd, ['rm', '--cached', '-r', '-q', '--', ...targets], {}, repo.root);
      } else {
        await git.run(repo.cwd, ['restore', '--staged', '--', ...targets], {}, repo.root);
      }
      return refreshNow(vaultId);
    });

    /**
     * Throws away working-tree changes: a tracked file goes back to its
     * staged (or committed) content, an untracked one to the recycle bin
     * over the app's own delete path.
     */
    ctx.ipc.handle('discard', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const paths = pathsOf(payload);
      const state = await computeState(vaultId);
      const untracked = new Set(
        state.state === 'ok' ? state.status.unstaged.filter((c) => c.kind === 'untracked').map((c) => c.path) : [],
      );
      const tracked = paths.filter((p) => !untracked.has(p));
      for (const path of paths.filter((p) => untracked.has(p))) {
        await ctx.vault.delete(path, { vaultId });
      }
      if (tracked.length > 0) {
        await git.run(repo.cwd, ['restore', '--worktree', '--', ...tracked], {}, repo.root);
        ctx.vault.announceChanges({ vaultId, changedPaths: tracked });
      }
      return refreshNow(vaultId);
    });

    /**
     * `commit`: the staged changes with `message`. During a merge an empty
     * message keeps git's own (`MERGE_MSG`); `amend` rewrites the last
     * commit (an empty message keeps its text); `push` sends the branch
     * right after. A commit whose push failed stays created -- the error
     * says so.
     */
    ctx.ipc.handle('commit', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const request = payload as { message?: unknown; amend?: unknown; push?: unknown };
      const message = typeof request.message === 'string' ? request.message : '';
      const amend = request.amend === true;
      const state = await computeState(vaultId);
      if (state.state !== 'ok') {
        throw new Error('This vault is not a Git repository.');
      }
      const merging = state.operation !== null;
      if (merging && state.status.conflicts.length > 0) {
        throw new Error('Resolve all merge conflicts before completing the merge.');
      }
      if (merging && amend) {
        throw new Error('A merge in progress cannot be amended. Complete or abort it first.');
      }
      if (amend && state.status.upstream !== null && state.status.ahead === 0) {
        throw new Error(
          `The last commit is already on ${state.status.upstream}. Amending it would rewrite published history, and Drey never force-pushes.`,
        );
      }
      const args = ['commit', ...(amend ? ['--amend'] : [])];
      if (message.trim() === '') {
        if (!merging && !amend) {
          throw new Error('Enter a commit message.');
        }
        await git.run(repo.root, [...args, '--no-edit']);
      } else {
        await git.run(repo.root, [...args, '-F', '-'], { input: message });
      }
      if (request.push === true) {
        try {
          const pushArgs = await pushArguments(vaultId, repo);
          await cancellable(vaultId, (signal) => git.run(repo.root, pushArgs, { signal }));
        } catch (error) {
          await refreshNow(vaultId).catch(() => undefined);
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`The commit was created, but pushing it failed: ${reason}`);
        }
      }
      return refreshNow(vaultId);
    });

    // -- branches ----------------------------------------------------------

    ctx.ipc.handle('checkout', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const request = payload as { name?: unknown; remote?: unknown };
      const name = typeof request.name === 'string' ? request.name : '';
      if (!isPlausibleBranchName(name)) {
        throw new Error(`Not a valid branch name: ${name}`);
      }
      const before = await headOf(repo);
      // A remote branch gets a local one tracking it (`origin/x` -> `x`).
      await git.run(repo.root, request.remote === true ? ['switch', '--track', name] : ['switch', name]);
      await announceBetween(vaultId, repo, before, await headOf(repo));
      return refreshNow(vaultId);
    });

    ctx.ipc.handle('createBranch', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const name = (payload as { name?: unknown }).name;
      if (typeof name !== 'string' || !isPlausibleBranchName(name)) {
        throw new Error(`Not a valid branch name: ${String(name)}`);
      }
      await git.run(repo.root, ['switch', '-c', name]);
      return refreshNow(vaultId);
    });

    // -- remote ------------------------------------------------------------

    ctx.ipc.handle('fetch', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      await cancellable(vaultId, (signal) => git.run(repo.root, ['fetch', '--prune'], { signal }));
      return refreshNow(vaultId);
    });

    ctx.ipc.handle('pull', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const before = await headOf(repo);
      try {
        await cancellable(vaultId, (signal) => git.run(repo.root, ['pull'], { signal }));
      } catch (error) {
        // A pull that stopped half-way (a merge conflict) has rewritten
        // files all the same: re-read the vault, then report the failure.
        ctx.vault.announceChanges({ vaultId });
        await refreshNow(vaultId).catch(() => undefined);
        throw error;
      }
      await announceBetween(vaultId, repo, before, await headOf(repo));
      return refreshNow(vaultId);
    });

    /** The `git push` arguments for the vault's branch (a new branch is published with `-u`). */
    const pushArguments = async (vaultId: string, repo: Repo): Promise<string[]> => {
      const state = await computeState(vaultId);
      if (state.state !== 'ok') {
        throw new Error('This vault is not a Git repository.');
      }
      const { branch, upstream } = state.status;
      if (upstream !== null) {
        return ['push'];
      }
      if (branch === null) {
        throw new Error('HEAD is detached: switch to a branch before pushing.');
      }
      const remotes = (await git.run(repo.root, ['remote'], { readOnly: true }))
        .split(/\r?\n/)
        .filter((r) => r !== '');
      if (remotes.length === 0) {
        throw new Error('This repository has no remote to push to.');
      }
      return ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], branch];
    };

    ctx.ipc.handle('push', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const args = await pushArguments(vaultId, repo);
      await cancellable(vaultId, (signal) => git.run(repo.root, args, { signal }));
      return refreshNow(vaultId);
    });

    // -- merge (ADR-0065 later change) ---------------------------------------

    /** True while the repository has a merge in progress. */
    const mergeInProgress = async (repo: Repo): Promise<boolean> => (await readOperation(repo)) !== null;

    /**
     * Merges `name` into the current branch. A merge that stops on
     * conflicts is not a failure here: the panel shows the merge state and
     * the conflicted files, which are resolved and staged, then the merge
     * is completed with a commit.
     */
    ctx.ipc.handle('merge', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const name = stringOf(payload, 'name');
      if (!isPlausibleBranchName(name)) {
        throw new Error(`Not a valid branch name: ${name}`);
      }
      const before = await headOf(repo);
      try {
        await git.run(repo.root, ['merge', '--no-edit', name]);
      } catch (error) {
        if (!(await mergeInProgress(repo))) {
          throw error;
        }
        // Stopped on conflicts: git has written the markers into the files.
        ctx.vault.announceChanges({ vaultId });
        return refreshNow(vaultId);
      }
      await announceBetween(vaultId, repo, before, await headOf(repo));
      return refreshNow(vaultId);
    });

    ctx.ipc.handle('mergeAbort', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      await git.run(repo.root, ['merge', '--abort']);
      ctx.vault.announceChanges({ vaultId });
      return refreshNow(vaultId);
    });

    /**
     * Settles one conflicted file with the current branch's version
     * (`ours`) or the incoming one (`theirs`) and stages it. When that side
     * deleted the file, the file is removed instead.
     */
    ctx.ipc.handle('resolve', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const path = stringOf(payload, 'path');
      const side = stringOf(payload, 'side');
      if (path === '' || (side !== 'ours' && side !== 'theirs')) {
        throw new Error('No file or side given.');
      }
      let present = true;
      try {
        await git.run(repo.cwd, ['checkout', `--${side}`, '--', path], {}, repo.root);
      } catch {
        present = false;
      }
      if (present) {
        await git.run(repo.cwd, ['add', '--', path], {}, repo.root);
        ctx.vault.announceChanges({ vaultId, changedPaths: [path] });
      } else {
        await git.run(repo.cwd, ['rm', '-f', '--quiet', '--', path], {}, repo.root);
        ctx.vault.announceChanges({ vaultId, deletedPaths: [path] });
      }
      return refreshNow(vaultId);
    });

    // -- stash ---------------------------------------------------------------

    ctx.ipc.handle('stashList', async (payload): Promise<GitStash[]> => {
      const repo = await repoOf(vaultIdOf(payload));
      const out = await git.run(repo.root, ['stash', 'list', `--format=${STASH_FORMAT}`], { readOnly: true });
      return parseStashList(out);
    });

    /** Puts the vault's changes (untracked files included) away and restores a clean tree. */
    ctx.ipc.handle('stashPush', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const note = stringOf(payload, 'message').trim();
      const state = await computeState(vaultId);
      if (state.state !== 'ok' || state.status.staged.length + state.status.unstaged.length === 0) {
        throw new Error('There is nothing to stash.');
      }
      await git.run(
        repo.cwd,
        ['stash', 'push', '--include-untracked', ...(note === '' ? [] : ['-m', note]), '--', '.'],
        {},
        repo.root,
      );
      ctx.vault.announceChanges({ vaultId });
      return refreshNow(vaultId);
    });

    /** Applies a stash and drops it (git keeps it when applying conflicts). */
    ctx.ipc.handle('stashPop', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const ref = stashRef(payload);
      try {
        await git.run(repo.root, ['stash', 'pop', ref]);
      } catch (error) {
        ctx.vault.announceChanges({ vaultId });
        await refreshNow(vaultId).catch(() => undefined);
        throw error;
      }
      ctx.vault.announceChanges({ vaultId });
      return refreshNow(vaultId);
    });

    ctx.ipc.handle('stashDrop', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      await git.run(repo.root, ['stash', 'drop', stashRef(payload)]);
      return refreshNow(vaultId);
    });

    ctx.ipc.handle('cancel', (payload) => {
      const controller = running.get(vaultIdOf(payload));
      controller?.abort();
      return controller !== undefined;
    });

    /** Settings changed the executable: look for git (and the repositories) again. */
    ctx.ipc.handle('configChanged', async () => {
      gitPath = ((await ctx.config.get<string>('gitPath')) ?? '').trim();
      located.clear();
      return refreshNow();
    });

    ctx.log('activated');
    // No status run here: activation must not block on git. The refresh
    // round after activation and the panel's first `status` call start it.
  },
};

export default plugin;
