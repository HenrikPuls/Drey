/**
 * Worktree cleanup (T-0044, ADR-0080): everything through real git —
 * `git worktree remove` / `git worktree prune` — never a bare rmdir on a
 * registered tree. Removal refuses dirt by default (the branch carries
 * the committed work; dirty content is never destroyed — the same rule
 * as `prepareWorktree`), global cleanup skips protected paths (live
 * runs) and tolerates per-item failure, and orphan folders are listed,
 * never deleted.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import type { RepoRef } from '../../shared/tickets';
import type { TicketsGit } from '../tickets-git';
import { isUnderAnyBase, legacyWorktreeBase, worktreeBaseFor } from './worktree-home';
import { normalizeForMatch, parseWorktreePorcelain } from './worktrees';

/** The exec seam cleanup drives (a `TicketsGit` instance). */
type GitSeam = Pick<TicketsGit, 'run'>;

export interface RemoveOptions {
  /** Skip the dirty refusal — the owner confirmed. Never the default. */
  readonly force?: boolean;
}

export type RemoveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly dirty: true; readonly status: string }
  | { readonly ok: false; readonly error: string };

/**
 * Removes one registered worktree. `status --porcelain` reads the tree
 * first — a tree that no longer answers to git is an error, not an
 * empty status — then `git worktree remove` does the work (`--force`
 * only with `force`). No `fsp.rm` on registered trees.
 */
export async function removeWorktree(
  git: GitSeam,
  repoPath: string,
  worktreePath: string,
  options: RemoveOptions = {},
): Promise<RemoveOutcome> {
  let status: string;
  try {
    status = await git.run(worktreePath, ['status', '--porcelain']);
  } catch (error) {
    return { ok: false, error: `the worktree cannot be inspected: ${messageOf(error)}` };
  }
  if (status.trim() !== '' && options.force !== true) {
    return { ok: false, dirty: true, status };
  }
  try {
    const args = ['worktree', 'remove', ...(options.force === true ? ['--force'] : []), worktreePath];
    await git.run(repoPath, args);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
  return { ok: true };
}

export interface CleanWorktreesInput {
  /** The board's repos (repos.md); a repo without a local `path:` has no fleet worktrees. */
  readonly repos: readonly RepoRef[];
  /** Absolute path of the tickets vault (the default base's root). */
  readonly vaultPath: string;
  /** The machine-local fleet root (`<userRoot>/fleet`) — the legacy base. */
  readonly fleetRoot: string;
  /** Worktree paths of live runs — never removed. */
  readonly protectedPaths: readonly string[];
}

export interface CleanupReport {
  /** Worktree paths removed (real `git worktree remove`). */
  readonly removed: readonly string[];
  /** Paths kept because they are dirty — reported, never destroyed. */
  readonly keptDirty: readonly string[];
  /** Everything that failed; the report continues past it. */
  readonly failed: readonly { readonly path: string; readonly error: string }[];
  /** Repo paths where `git worktree prune` ran. */
  readonly prunedRepos: readonly string[];
}

/**
 * The global cleanup (the Clean up button) and the boot migration in
 * one rule: per repo, every registered worktree under the repo's new or
 * legacy base that is not protected gets `removeWorktree`'s treatment;
 * then one `git worktree prune` clears the admin entries. The legacy
 * base folder itself is rmdir'd when empty (best effort).
 */
export async function cleanWorktrees(git: GitSeam, input: CleanWorktreesInput): Promise<CleanupReport> {
  const protectedSet = new Set(input.protectedPaths.map(normalizeForMatch));
  const removed: string[] = [];
  const keptDirty: string[] = [];
  const failed: { path: string; error: string }[] = [];
  const prunedRepos: string[] = [];
  for (const repo of input.repos) {
    if (repo.path === null) {
      continue;
    }
    const bases = [worktreeBaseFor(input.vaultPath, repo), legacyWorktreeBase(input.fleetRoot)];
    let listing: string;
    try {
      listing = await git.run(repo.path, ['worktree', 'list', '--porcelain']);
    } catch (error) {
      failed.push({ path: repo.path, error: `worktree list failed: ${messageOf(error)}` });
      continue;
    }
    for (const entry of parseWorktreePorcelain(listing)) {
      // Prunable entries (vanished trees) are the prune's job; the
      // repo's own checkout is never a fleet worktree.
      if (entry.prunable || !isUnderAnyBase(entry.path, bases) || samePath(entry.path, repo.path)) {
        continue;
      }
      if (protectedSet.has(normalizeForMatch(entry.path))) {
        continue;
      }
      const outcome = await removeWorktree(git, repo.path, entry.path);
      if (outcome.ok) {
        removed.push(entry.path);
      } else if (outcome.dirty === true) {
        keptDirty.push(entry.path);
      } else {
        failed.push({ path: entry.path, error: outcome.error });
      }
    }
    try {
      await git.run(repo.path, ['worktree', 'prune']);
      prunedRepos.push(repo.path);
    } catch (error) {
      failed.push({ path: repo.path, error: `prune failed: ${messageOf(error)}` });
    }
    await fsp.rmdir(legacyWorktreeBase(input.fleetRoot)).catch(() => undefined);
  }
  return { removed, keptDirty, failed, prunedRepos };
}

/**
 * Folders under the bases that no run record (live or historical)
 * names — listed only, never deleted (the boot sweep's report).
 * `.stale-*` move-aside folders are the kept-not-deleted guarantee and
 * dot entries are invisible; neither is an orphan.
 */
export async function listOrphans(
  bases: readonly string[],
  runWorktreePaths: readonly string[],
): Promise<readonly string[]> {
  const known = new Set(runWorktreePaths.map(normalizeForMatch));
  const orphans: string[] = [];
  for (const base of bases) {
    const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const dirent of entries) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.') || dirent.name.includes('.stale-')) {
        continue;
      }
      const full = path.join(base, dirent.name);
      if (!known.has(normalizeForMatch(full))) {
        orphans.push(full);
      }
    }
  }
  return orphans.sort();
}

function samePath(a: string, b: string): boolean {
  return normalizeForMatch(a) === normalizeForMatch(b);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
