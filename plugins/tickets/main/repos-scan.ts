/**
 * The settings page's "Add from folder" scan (req-72): a folder the owner
 * picks is probed for git repositories — itself and its non-hidden
 * subdirectories one level deep. A checkout's `.git` entry (file or
 * folder — worktrees carry a file), the origin remote and the current
 * branch become the candidate's seed. Everything probes through real git
 * over the TicketsGit seam; a folder that is no repo is simply not a
 * candidate, and an unreadable one is skipped as noise.
 */
import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import type { RepoCandidate } from '../shared/tickets';

/** The git seam — TicketsGit.run (one queue per working directory). */
export type RepoScanExec = (cwd: string, args: readonly string[]) => Promise<string>;

export interface RepoScanOutcome {
  readonly candidates: readonly RepoCandidate[];
  /** Subfolders that could not be read (permissions) — noise, not a failure. */
  readonly skipped: readonly string[];
}

export async function scanRepoFolder(folder: string, run: RepoScanExec): Promise<RepoScanOutcome> {
  const candidates: RepoCandidate[] = [];
  const skipped: string[] = [];
  const dirs = [folder, ...(await subfolders(folder, skipped))];
  for (const dir of dirs) {
    if (!(await isGitRepo(dir))) {
      continue;
    }
    candidates.push({
      name: path.basename(dir),
      url: await probe(run, dir, ['remote', 'get-url', 'origin']),
      branch: await probe(run, dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      path: dir,
    });
  }
  return { candidates, skipped };
}

async function subfolders(folder: string, skipped: string[]): Promise<readonly string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch {
    skipped.push(folder);
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) {
      continue; // hidden helpers and the fleet's _worktrees are not project repos
    }
    dirs.push(path.join(folder, entry.name));
  }
  return dirs;
}

async function isGitRepo(dir: string): Promise<boolean> {
  return await fsp
    .stat(path.join(dir, '.git'))
    .then(() => true)
    .catch(() => false);
}

/** One git probe: trimmed stdout, or null when git fails (no remote, detached). */
async function probe(run: RepoScanExec, cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const out = (await run(cwd, args)).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}
