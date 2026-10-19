/**
 * Where fleet worktrees live (T-0044, ADR-0080): one visible base folder
 * per work repo, default `<ticketsRepo>/_worktrees/<ticket-id>/` — a
 * sibling of `tickets/` at the repo root, no longer hidden under the
 * machine-local fleet root. `_`-prefixed root folders are reserved: the
 * vault's file tree, md index and watcher skip them, and the repo's
 * .gitignore covers the base (ensured by the boot sweep). A repo may
 * override its base with a `worktrees:` key in _meta/repos.md — an
 * absolute path, or one relative to the tickets repo root.
 *
 * Pure: no filesystem access, no git — the path discipline only.
 */
import * as path from 'node:path';
import type { RepoRef } from '../../shared/tickets';
import { normalizeForMatch } from './worktrees';

/** The reserved root folder holding the fleet's worktrees by default. */
export const WORKTREES_DIR = '_worktrees';

/**
 * The repo's worktree base folder: the `worktrees:` override when set
 * (relative values resolve against the tickets repo root), else
 * `<ticketsRepo>/_worktrees`.
 */
export function worktreeBaseFor(vaultPath: string, repo: RepoRef): string {
  const override = repo.worktrees?.trim() ?? '';
  if (override !== '') {
    return path.resolve(vaultPath, override);
  }
  return path.join(vaultPath, WORKTREES_DIR);
}

/**
 * The worktree folder name: the bare ticket id — ids are minted
 * board-wide and each ticket names exactly one repo, so a repo prefix
 * buys nothing (ADR-0080).
 */
export function worktreeFolderName(ticketId: string): string {
  return ticketId;
}

/** The worktree's absolute path for one ticket on one repo. */
export function worktreePathFor(vaultPath: string, repo: RepoRef, ticketId: string): string {
  return path.join(worktreeBaseFor(vaultPath, repo), worktreeFolderName(ticketId));
}

/**
 * The pre-T-0044 base (`<fleetRoot>/worktrees`) with its
 * `<repo>-<ticket>` folder names. Never written again; the boot
 * migration and the Clean up button empty it (live runs keep theirs
 * until they settle).
 */
export function legacyWorktreeBase(fleetRoot: string): string {
  return path.join(fleetRoot, 'worktrees');
}

/**
 * Whether `p` is `base` itself or a path under it — normalized and
 * case-folded on win32 (porcelain prints `C:/…`, `path.join` yields
 * backslashes), the `worktrees.ts` compare discipline.
 */
export function isUnderAnyBase(p: string, bases: readonly string[]): boolean {
  const needle = normalizeForMatch(p);
  return bases.some((base) => {
    const hay = normalizeForMatch(base);
    return needle === hay || needle.startsWith(`${hay}/`);
  });
}
