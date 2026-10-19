/**
 * The fleet's worktree preparation (T-0047, ADR-0075): idempotent per
 * ticket. `git worktree add` alone fails on the second run for the same
 * ticket (next phase, gate retry) with "already exists", so the state
 * of the existing checkout decides what happens instead:
 *
 * - registered and on `t/<id>` — **reused** as is (clean or dirty; a
 *   retry wants exactly the half-finished work);
 * - unregistered, directory missing or empty — **created** (prune, then
 *   add — `-b` only when the branch does not exist yet);
 * - stale (content at the path, no healthy registration) and clean —
 *   **recreated**;
 * - stale and dirty — **moved-aside** to `<path>.stale-<stamp>`, never
 *   deleted; an uninspectable directory counts as dirty (what cannot be
 *   proven clean is not destroyed);
 * - wrong branch, locked, or a rebase/merge in progress — a descriptive
 *   error, nothing modified (no automatic repair).
 *
 * Every call is serialized by a module-level lock keyed by the repo
 * path: two concurrent starts for one ticket cannot race on
 * `worktree add`, and neither can two different tickets' prepares in
 * the same repo (workers: 2/4 share it — one runner process, one
 * supervisor per adapter, only module scope is shared).
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { TicketsGit } from '../tickets-git';
import type { RunRequest, WorktreeOutcome } from './protocol';

/** The exec seam the state machine drives (a `TicketsGit` instance). */
type GitSeam = Pick<TicketsGit, 'run'>;

type PrepareRequest = Pick<RunRequest, 'repoPath' | 'branch' | 'baseRef'>;

export interface PreparedWorktree {
  readonly outcome: WorktreeOutcome;
  /** True only for 'recreated' | 'moved-aside' — prior session context
   *  must not be resumed (consumed by T-0049; nothing reads it in v1). */
  readonly sessionInvalidated: boolean;
  /** Where the stale dirty tree was parked, when outcome === 'moved-aside'. */
  readonly movedTo: string | null;
}

export interface WorktreeListEntry {
  /** Normalized: forward slashes (porcelain prints `C:/…`; `path.join`
   *  yields backslashes — compared case-folded on win32, with a
   *  `realpath` second chance against path aliases, see
   *  `findWorktreeEntry`). */
  readonly path: string;
  /** `refs/heads/<name>`; null = detached or bare. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/** Parses `git worktree list --porcelain` (entries separated by blank
 *  lines; `locked`/`prunable` may carry a reason after the keyword). */
export function parseWorktreePorcelain(text: string): readonly WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: { path: string; branch: string | null; detached: boolean; locked: boolean; prunable: boolean } | null =
    null;
  const flush = (): void => {
    if (current !== null) {
      entries.push(current);
    }
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = {
        path: line.slice('worktree '.length).trim().replaceAll('\\', '/'),
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line.startsWith('locked')) {
      current.locked = true;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  flush();
  return entries;
}

/**
 * Decides the worktree's fate per the ticket's state table. Throws
 * (descriptively, before any mutation) for the fail rows; serialized by
 * the module-level repo lock.
 */
export async function prepareWorktree(
  git: GitSeam,
  request: PrepareRequest,
  worktreePath: string,
  now: () => Date,
): Promise<PreparedWorktree> {
  return withRepoLock(request.repoPath, () => prepareUnlocked(git, request, worktreePath, now));
}

// -------------------------------------------------------------------------

const repoLocks = new Map<string, Promise<unknown>>();

/** One worktree-mutating sequence per repo at a time; the stored tail is
 *  the SETTLED promise, so a failing prepare neither blocks the next
 *  call nor leaves an unhandled rejection (the TicketsGit.run pattern). */
function withRepoLock<T>(repoPath: string, task: () => Promise<T>): Promise<T> {
  const key = repoLockKey(repoPath);
  const prev = repoLocks.get(key) ?? Promise.resolve();
  const result = prev.then(task);
  const settled = result.catch(() => undefined);
  repoLocks.set(key, settled);
  void settled.then(() => {
    if (repoLocks.get(key) === settled) {
      repoLocks.delete(key);
    }
  });
  return result;
}

async function prepareUnlocked(
  git: GitSeam,
  request: PrepareRequest,
  worktreePath: string,
  now: () => Date,
): Promise<PreparedWorktree> {
  const listing = await git.run(request.repoPath, ['worktree', 'list', '--porcelain']);
  const entry = await findWorktreeEntry(listing, worktreePath);

  // Registered and healthy: reuse as is, clean or dirty — zero
  // mutating git calls.
  if (entry !== null && !entry.prunable) {
    const expected = `refs/heads/${request.branch}`;
    if (entry.detached || entry.branch !== expected) {
      const found = entry.detached ? 'a detached HEAD' : entry.branch ?? 'no branch';
      throw new Error(
        `worktree ${worktreePath} is on ${found}, expected ${request.branch} — refusing to touch it`,
      );
    }
    if (entry.locked) {
      throw new Error(`worktree ${worktreePath} is locked`);
    }
    await assertNoOperationInProgress(git, worktreePath);
    return { outcome: 'reused', sessionInvalidated: false, movedTo: null };
  }

  // No healthy registration: a missing or empty directory is a plain
  // create (prune clears the leftover admin entry first).
  const state = await directoryState(worktreePath);
  if (state !== 'content') {
    await git.run(request.repoPath, ['worktree', 'prune']);
    await addWorktree(git, request, worktreePath);
    return { outcome: 'created', sessionInvalidated: false, movedTo: null };
  }

  // Content at the path without a registration — the stale rows. A
  // directory that no longer answers to git cannot be proven clean:
  // it is moved aside, never deleted.
  const branch = await currentBranch(git, worktreePath);
  if (branch === null) {
    return replaceStale(git, request, worktreePath, now);
  }
  if (branch !== request.branch) {
    const found = branch === 'HEAD' ? 'a detached HEAD' : branch;
    throw new Error(
      `worktree ${worktreePath} is on ${found}, expected ${request.branch} — refusing to touch it`,
    );
  }
  await assertNoOperationInProgress(git, worktreePath);
  const status = await git.run(worktreePath, ['status', '--porcelain']);
  if (status.trim() === '') {
    await git.run(request.repoPath, ['worktree', 'prune']);
    await fsp.rm(worktreePath, { recursive: true, force: true });
    await addWorktree(git, request, worktreePath);
    return { outcome: 'recreated', sessionInvalidated: true, movedTo: null };
  }
  return replaceStale(git, request, worktreePath, now);
}

/** The dirty-stale row: rename aside (kept), then a fresh checkout. */
async function replaceStale(
  git: GitSeam,
  request: PrepareRequest,
  worktreePath: string,
  now: () => Date,
): Promise<PreparedWorktree> {
  const movedTo = await moveAside(worktreePath, now);
  await git.run(request.repoPath, ['worktree', 'prune']);
  await addWorktree(git, request, worktreePath);
  return { outcome: 'moved-aside', sessionInvalidated: true, movedTo };
}

/** `worktree add` on the existing branch, or `-b` from the base ref
 *  when the ticket's branch does not exist yet. Never `--force`. */
async function addWorktree(git: GitSeam, request: PrepareRequest, worktreePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
  const hasBranch = await git
    .run(request.repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${request.branch}`])
    .then(() => true)
    .catch(() => false);
  const args = hasBranch
    ? ['worktree', 'add', worktreePath, request.branch]
    : ['worktree', 'add', '-b', request.branch, worktreePath, request.baseRef ?? 'HEAD'];
  await git.run(request.repoPath, args);
}

/** A rebase/merge must never be reused over or moved aside mid-flight.
 *  The markers resolve through the worktree's own git dir
 *  (`--git-path` prints the admin-absolute path), so this is
 *  locale-free and needs no git status parsing. */
const IN_PROGRESS_MARKERS: readonly { readonly marker: string; readonly op: string }[] = [
  { marker: 'rebase-merge', op: 'rebase' },
  { marker: 'rebase-apply', op: 'rebase' },
  { marker: 'MERGE_HEAD', op: 'merge' },
  { marker: 'CHERRY_PICK_HEAD', op: 'cherry-pick' },
  { marker: 'REVERT_HEAD', op: 'revert' },
  { marker: 'BISECT_LOG', op: 'bisect' },
];

async function assertNoOperationInProgress(git: GitSeam, worktreePath: string): Promise<void> {
  for (const { marker, op } of IN_PROGRESS_MARKERS) {
    const out = await git.run(worktreePath, ['rev-parse', '--git-path', marker]);
    const file = out.trim();
    if (file === '') {
      continue;
    }
    const abs = path.isAbsolute(file) ? file : path.join(worktreePath, file);
    if (await fileExists(abs)) {
      throw new Error(`worktree ${worktreePath} has a ${op} in progress`);
    }
  }
}

/** The branch a still-runnable directory is on (`t/<id>`; `HEAD` when
 *  detached), or null when the directory no longer answers to git. */
async function currentBranch(git: GitSeam, worktreePath: string): Promise<string | null> {
  try {
    return (await git.run(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

type DirState = 'missing' | 'empty' | 'content';

async function directoryState(dir: string): Promise<DirState> {
  const entries = await fsp.readdir(dir).then(
    (list) => list,
    () => null,
  );
  if (entries === null) {
    return 'missing';
  }
  return entries.length === 0 ? 'empty' : 'content';
}

/** `<path>.stale-<YYYYMMDDTHHMMSS>`, suffixed -2, -3, … on collision —
 *  the injected clock may be frozen, so same-second collisions are a
 *  spec reality. */
async function moveAside(worktreePath: string, now: () => Date): Promise<string> {
  const stamp = now().toISOString().replaceAll(/[-:]/g, '').slice(0, 15);
  let candidate = `${worktreePath}.stale-${stamp}`;
  let n = 2;
  while (await fileExists(candidate)) {
    candidate = `${worktreePath}.stale-${stamp}-${n}`;
    n++;
  }
  await fsp.rename(worktreePath, candidate);
  return candidate;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolved, forward-slashed, case-folded on win32 — porcelain prints
 *  `C:/…` while `path.join` yields backslashes. */
function repoLockKey(p: string): string {
  return normalizeForMatch(p);
}

function sameWorktreePath(a: string, b: string): boolean {
  return normalizeForMatch(a) === normalizeForMatch(b);
}

/**
 * Finds the worktree's entry in the listing. String form decides first
 * (the common case — both sides spell the same path); as a second
 * chance both sides go through `realpath`, because git canonicalizes
 * the paths it reports through the filesystem while the caller's path
 * can reach the same directory through an alias — an 8.3 short name
 * (`RUNNER~1` for `runneradmin`, the shape of the GitHub Windows
 * runner's temp dir) or a junction. A path that cannot be resolved
 * (a registered but vanished tree) only ever matches by string form.
 */
async function findWorktreeEntry(
  porcelain: string,
  worktreePath: string,
): Promise<WorktreeListEntry | null> {
  const entries = parseWorktreePorcelain(porcelain);
  for (const entry of entries) {
    if (sameWorktreePath(entry.path, worktreePath)) {
      return entry;
    }
  }
  const requested = await realPathOrNull(worktreePath);
  if (requested === null) {
    return null;
  }
  for (const entry of entries) {
    const real = await realPathOrNull(entry.path);
    if (real !== null && sameWorktreePath(real, requested)) {
      return entry;
    }
  }
  return null;
}

async function realPathOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

function normalizeForMatch(p: string): string {
  const resolved = path.resolve(p).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
