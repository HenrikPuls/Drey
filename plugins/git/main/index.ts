import type { MainPluginContext, MainPluginModule } from '../../../shared/plugin-api';
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  isPlausibleBranchName,
  parseBranches,
  parseLog,
  parseNameStatus,
  parseStatus,
  toRepoPath,
  type GitBranch,
  type GitLogEntry,
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
}

type Located = { kind: 'repo'; repo: Repo } | { kind: 'none'; detail?: string } | { kind: 'no-git' };

const REFRESH_DEBOUNCE_MS = 250;
const LOG_LIMIT = 50;

function vaultIdOf(payload: unknown): string {
  const id = (payload as { vaultId?: unknown } | null)?.vaultId;
  if (typeof id !== 'string' || id === '') {
    throw new Error('No vault given.');
  }
  return id;
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
          const out = await git.run(vault.path, ['rev-parse', '--show-toplevel', '--show-prefix'], {
            readOnly: true,
          });
          const [root = '', prefix = ''] = out.split(/\r?\n/);
          result = { kind: 'repo', repo: { root, prefix, cwd: vault.path } };
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
      return { vaultId, state: 'ok', root: repo.root, prefix: repo.prefix, status, stagedOutside };
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

    ctx.ipc.handle('log', async (payload): Promise<GitLogEntry[]> => {
      const repo = await repoOf(vaultIdOf(payload));
      if ((await headOf(repo)) === '') {
        return []; // a repository without commits has no log
      }
      const out = await git.run(
        repo.root,
        ['log', '-n', String(LOG_LIMIT), `--pretty=format:${LOG_FORMAT}`],
        { readOnly: true },
      );
      return parseLog(out);
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
        const spec = `${request.rev === 'head' ? 'HEAD' : ''}:${toRepoPath(path, repo.prefix)}`;
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

    ctx.ipc.handle('commit', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const message = (payload as { message?: unknown }).message;
      if (typeof message !== 'string' || message.trim() === '') {
        throw new Error('Enter a commit message.');
      }
      await git.run(repo.root, ['commit', '-F', '-'], { input: message });
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

    ctx.ipc.handle('push', async (payload) => {
      const vaultId = vaultIdOf(payload);
      const repo = await repoOf(vaultId);
      const state = await computeState(vaultId);
      if (state.state !== 'ok') {
        throw new Error('This vault is not a Git repository.');
      }
      const { branch, upstream } = state.status;
      let args: string[] = ['push'];
      if (upstream === null) {
        if (branch === null) {
          throw new Error('HEAD is detached: switch to a branch before pushing.');
        }
        const remotes = (await git.run(repo.root, ['remote'], { readOnly: true }))
          .split(/\r?\n/)
          .filter((r) => r !== '');
        if (remotes.length === 0) {
          throw new Error('This repository has no remote to push to.');
        }
        // First push of a new branch: publish it and remember the upstream.
        args = ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], branch];
      }
      await cancellable(vaultId, (signal) => git.run(repo.root, args, { signal }));
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
