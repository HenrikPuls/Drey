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
 *   proven clean is not destroyed) — including a leftover folder whose
 *   git answer is an inherited one: the base sits inside the tickets
 *   vault, itself a repo, and a rev-parse would walk up into it;
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

type PrepareRequest = Pick<RunRequest, 'repoPath' | 'branch' | 'baseRef' | 'links'>;

export interface PreparedWorktree {
  readonly outcome: WorktreeOutcome;
  /** True only for 'recreated' | 'moved-aside' — prior session context
   *  must not be resumed (consumed by T-0049; nothing reads it in v1). */
  readonly sessionInvalidated: boolean;
  /** Where the stale dirty tree was parked, when outcome === 'moved-aside'. */
  readonly movedTo: string | null;
  /** What became of the repo's `link:` folders (req-56); absent when it names none. */
  readonly links?: LinkReport;
}

/** The `link:` folders by fate: linked now, already there, or left out (with why). */
export interface LinkReport {
  readonly linked: readonly string[];
  readonly present: readonly string[];
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
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
 * the module-level repo lock. `isLive` (T-0044) guards the create path's
 * branch-conflict healing: a registered checkout of the same branch that
 * belongs to a live run is never touched.
 */
export async function prepareWorktree(
  git: GitSeam,
  request: PrepareRequest,
  worktreePath: string,
  now: () => Date,
  isLive?: (worktreePath: string) => boolean,
): Promise<PreparedWorktree> {
  return withRepoLock(request.repoPath, async () => {
    const prepared = await prepareUnlocked(git, request, worktreePath, now, isLive);
    const links = request.links ?? [];
    return links.length === 0 ? prepared : { ...prepared, links: await linkShared(git, request.repoPath, worktreePath, links) };
  });
}

/**
 * Links the repo's git-ignored toolchain folders into the worktree
 * (req-56): a fresh checkout has no `.tools` / `node_modules`, and every
 * worker spent its first calls finding that out and improvising —
 * junctions of its own, even `npm ci`. A folder is linked only when the
 * checkout has it, the worktree does not, and git ignores it there (a
 * link git would see is a change on the ticket branch). A junction on
 * Windows (no admin rights needed), a directory symlink elsewhere.
 */
export async function linkShared(
  git: GitSeam,
  repoPath: string,
  worktreePath: string,
  links: readonly string[],
): Promise<LinkReport> {
  const linked: string[] = [];
  const present: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const rel of links) {
    const source = path.join(repoPath, rel);
    const target = path.join(worktreePath, rel);
    if (await lexists(target)) {
      present.push(rel);
      continue;
    }
    if (!(await isDirectory(source))) {
      skipped.push({ path: rel, reason: 'the checkout has no such folder' });
      continue;
    }
    // Asked as a folder (`rel/`): the link does not exist yet, and a
    // folder-only pattern (`node_modules/`) matches nothing else. The
    // seam runs git with --literal-pathspecs, which check-ignore refuses
    // outright — the second flag lifts it for this one call.
    const ignored = await git
      .run(worktreePath, ['--no-literal-pathspecs', 'check-ignore', '-q', '--', `${rel}/`])
      .then(() => true)
      .catch(() => false);
    if (!ignored) {
      skipped.push({ path: rel, reason: 'git does not ignore it — a link would show as a change' });
      continue;
    }
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(rel);
    } catch (error) {
      skipped.push({ path: rel, reason: `link failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { linked, present, skipped };
}

/**
 * Removes the links before a worktree is deleted, so a recursive delete
 * can never reach through a junction into the checkout's own folders.
 * Only symbolic links / junctions are removed; a real folder stays. The
 * top level is swept too: earlier workers made such junctions themselves.
 * Shared with every removal path (worktree-clean, the board's Files
 * command) — git's own worktree removal leaves junctions behind.
 */
export async function unlinkShared(worktreePath: string, links: readonly string[]): Promise<void> {
  const top = await fsp.readdir(worktreePath).catch(() => [] as string[]);
  for (const rel of new Set([...links, ...top])) {
    const target = path.join(worktreePath, rel);
    const stat = await fsp.lstat(target).catch(() => null);
    if (stat?.isSymbolicLink() === true) {
      await fsp.unlink(target).catch(() => fsp.rmdir(target));
    }
  }
}

async function lexists(p: string): Promise<boolean> {
  return fsp.lstat(p).then(
    () => true,
    () => false,
  );
}

async function isDirectory(p: string): Promise<boolean> {
  return fsp.stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );
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
  isLive?: (worktreePath: string) => boolean,
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
    await addWorktree(git, request, worktreePath, isLive);
    return { outcome: 'created', sessionInvalidated: false, movedTo: null };
  }

  // Content at the path without a registration — the stale rows. A
  // directory that no longer answers to git cannot be proven clean:
  // it is moved aside, never deleted.
  const branch = await currentBranch(git, worktreePath);
  if (branch === null) {
    return replaceStale(git, request, worktreePath, now, isLive);
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
    await unlinkShared(worktreePath, request.links ?? []);
    await fsp.rm(worktreePath, { recursive: true, force: true });
    await addWorktree(git, request, worktreePath, isLive);
    return { outcome: 'recreated', sessionInvalidated: true, movedTo: null };
  }
  return replaceStale(git, request, worktreePath, now, isLive);
}

/** The dirty-stale row: rename aside (kept), then a fresh checkout. */
async function replaceStale(
  git: GitSeam,
  request: PrepareRequest,
  worktreePath: string,
  now: () => Date,
  isLive?: (worktreePath: string) => boolean,
): Promise<PreparedWorktree> {
  const movedTo = await moveAside(worktreePath, now);
  await git.run(request.repoPath, ['worktree', 'prune']);
  await addWorktree(git, request, worktreePath, isLive);
  return { outcome: 'moved-aside', sessionInvalidated: true, movedTo };
}

/** `worktree add` on the existing branch, or `-b` from the base ref
 *  when the ticket's branch does not exist yet. Never `--force`. */
async function addWorktree(
  git: GitSeam,
  request: PrepareRequest,
  worktreePath: string,
  isLive?: (worktreePath: string) => boolean,
): Promise<void> {
  await healBranchConflict(git, request, isLive);
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

/**
 * The re-run trap (T-0044, ADR-0080): `git worktree add` refuses a
 * branch another registered worktree still has checked out — a settled
 * ticket's leftover checkout (typically in the legacy fleet root) would
 * make every retry fail forever. A conflicting registration that is
 * provably clean and not live is removed first (real git, never
 * `--force`); anything else is a descriptive refusal.
 */
async function healBranchConflict(
  git: GitSeam,
  request: PrepareRequest,
  isLive?: (worktreePath: string) => boolean,
): Promise<void> {
  const listing = await git.run(request.repoPath, ['worktree', 'list', '--porcelain']);
  const expected = `refs/heads/${request.branch}`;
  for (const entry of parseWorktreePorcelain(listing)) {
    if (entry.branch !== expected || entry.prunable) {
      continue; // prunable admin leftovers are the following prune's job
    }
    if (sameWorktreePath(entry.path, request.repoPath)) {
      throw new Error(
        `branch ${request.branch} is checked out in the repo's own checkout (${entry.path}) — switch it back first`,
      );
    }
    if (isLive !== undefined && isLive(entry.path)) {
      throw new Error(
        `branch ${request.branch} is checked out in ${entry.path}, which a live run is working in — stop the run first`,
      );
    }
    if (entry.locked) {
      throw new Error(`branch ${request.branch} is checked out in the locked worktree ${entry.path}`);
    }
    const status = await git.run(entry.path, ['status', '--porcelain']).catch(() => null);
    if (status === null) {
      throw new Error(
        `branch ${request.branch} is checked out in ${entry.path}, which no longer answers to git — remove it by hand`,
      );
    }
    if (status.trim() !== '') {
      throw new Error(
        `branch ${request.branch} is checked out in the dirty worktree ${entry.path} — commit or stash there, then retry`,
      );
    }
    // The links go first: git's worktree removal leaves junctions behind,
    // and a leftover folder at the path poisons the next prepare.
    await unlinkShared(entry.path, request.links ?? []);
    await git.run(request.repoPath, ['worktree', 'remove', entry.path]);
  }
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
 *  detached), or null when the directory no longer answers to git *as
 *  itself*. The worktree base sits inside the tickets vault — itself a
 *  git repo — so a bare rev-parse walks up out of a leftover folder and
 *  reports the VAULT's branch as if it were the folder's; the toplevel
 *  guard turns that inherited answer back into "no longer answers". */
async function currentBranch(git: GitSeam, worktreePath: string): Promise<string | null> {
  try {
    const toplevel = (await git.run(worktreePath, ['rev-parse', '--show-toplevel'])).trim();
    if (!(await isOwnToplevel(toplevel, worktreePath))) {
      return null;
    }
    return (await git.run(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

/** True when git's toplevel IS the worktree path (either spelling — git
 *  reports canonical paths while the caller may hold an alias). */
async function isOwnToplevel(toplevel: string, worktreePath: string): Promise<boolean> {
  if (sameWorktreePath(toplevel, worktreePath)) {
    return true;
  }
  const realToplevel = await realPathOrNull(toplevel);
  const realWorktree = await realPathOrNull(worktreePath);
  return realToplevel !== null && realWorktree !== null && sameWorktreePath(realToplevel, realWorktree);
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

/** realpath, or null when the path does not resolve — the resolver of the
 *  alias second chance, shared with the worktree-clean rules. */
export async function realPathOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/** Resolved, forward-slashed, case-folded on win32 — the one way paths
 *  from git porcelain and paths from `path.join` compare equal. Shared
 *  with the worktree home/clean rules (T-0044). */
export function normalizeForMatch(p: string): string {
  const resolved = path.resolve(p).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
