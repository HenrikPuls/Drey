/**
 * The bounded repository scan under a parent vault (T-0045, ADR-0083):
 * a vault that is no repository itself (its own `locate()` said `none`)
 * may still have repositories below it — `E:\projects` with `drey/` and
 * `drey-tickets/` inside. Pure `fs.promises`, no git: a folder IS a
 * repository when it carries a `.git` entry (a directory for an ordinary
 * clone, a FILE for a linked worktree — the fleet's own worktrees), and
 * the caller turns the found roots into status entries.
 *
 * Cost bounds are constants (the plan's decision): depth 3 below the
 * vault root, at most 25 repositories per vault (clipped and logged).
 * Dot-directories (covering `.git`, `.tools`, `.drafts`),
 * `node_modules`, reserved `_`-folders at the vault root (ADR-0080) and
 * the subtrees of OTHER registered vaults are never walked; symlinks
 * are not followed.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** How many folder levels below the vault root the scan looks at. */
export const SCAN_DEPTH = 3;

/** How many repositories one vault surfaces at most; more are clipped. */
export const SCAN_LIMIT = 25;

/** One repository the scan found below a vault root. */
export interface DiscoveredRepo {
  /** Absolute repository root. */
  readonly root: string;
  /** Repo root relative to the vault root, forward slashes (`drey`). */
  readonly subPath: string;
}

/** The same drive-letter/case/slash form on both sides of a compare. */
function comparable(p: string): string {
  const resolved = p.replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether two folders overlap at all: equal, or one holds the other. */
function overlaps(candidate: string, other: string): boolean {
  return (
    candidate === other || candidate.startsWith(`${other}/`) || other.startsWith(`${candidate}/`)
  );
}

/** Whether a directory carries the repository marker (`.git`, file or directory). */
async function isRepository(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks `vaultRoot` (bounded, see the constants) and returns the
 * repositories below it. `skipRoots` are the absolute roots of the OTHER
 * registered vaults: their subtrees are not walked, and a candidate
 * overlapping any of them — an ancestor (a repository with a registered
 * vault inside) or a descendant — is dropped, so what another vault
 * already reports is never surfaced twice and a plugin-managed vault
 * (T-0042) keeps its own protection authoritative.
 */
export async function discoverRepos(
  vaultRoot: string,
  skipRoots: readonly string[],
): Promise<{ readonly repos: readonly DiscoveredRepo[]; readonly clipped: boolean }> {
  const skipped = new Set(skipRoots.map(comparable));
  const found: DiscoveredRepo[] = [];
  // Depth-first with an explicit stack; entries are absolute folders at
  // depth 1..SCAN_DEPTH below the vault root.
  const pending: Array<{ dir: string; depth: number }> = [{ dir: vaultRoot, depth: 0 }];
  while (pending.length > 0) {
    const { dir, depth } = pending.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder (permissions, gone mid-scan): not ours to fail on
    }
    for (const entry of entries) {
      // A symlink is never a directory here (lstat semantics), so links
      // are not followed; `.git` markers are checked per folder below.
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      if (depth === 0 && entry.name.startsWith('_')) {
        continue; // reserved root folders (ADR-0080): machine state, not vault content
      }
      const child = join(dir, entry.name);
      if (skipped.has(comparable(child))) {
        continue; // another registered vault's subtree
      }
      const childDepth = depth + 1;
      if (childDepth > SCAN_DEPTH) {
        continue; // beyond the bound: neither surfaced nor walked
      }
      if (await isRepository(child)) {
        found.push({ root: child, subPath: relative(vaultRoot, child).split(sep).join('/') });
        continue; // a found repository is never descended into (no nested surfacing)
      }
      pending.push({ dir: child, depth: childDepth });
    }
  }
  const bySubPath = [...found].sort((a, b) => a.subPath.localeCompare(b.subPath));
  const repos = bySubPath.filter((repo) => {
    const key = comparable(repo.root);
    return ![...skipped].some((skip) => overlaps(key, skip));
  });
  return {
    repos: repos.slice(0, SCAN_LIMIT),
    clipped: repos.length > SCAN_LIMIT,
  };
}
