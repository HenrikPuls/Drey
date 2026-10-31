/**
 * The context pack's file-backed halves (T-0048): the repo's agent
 * instructions and the worktree's diff stat — the reads stay here, out
 * of the pure composers, so the instruction stays testable and the
 * cache-stable prefix (instructions + phase template) stays byte-stable.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { TicketsGit } from '../tickets-git';

/**
 * The work repo's agent instructions, verbatim and never capped — the
 * stable in-repo prefix every phase instruction opens with. The repo's
 * `instructions:` file (req-79) first — a short brief for unattended
 * runs instead of the pair-programming rules every model call would
 * otherwise carry — then `CLAUDE.md`, then `AGENTS.md`; null when the
 * repo carries none of them (or the checkout is unreachable).
 */
export async function readRepoInstructions(repoPath: string, configured: string | null = null): Promise<string | null> {
  const names = configured !== null ? [configured, 'CLAUDE.md', 'AGENTS.md'] : ['CLAUDE.md', 'AGENTS.md'];
  for (const name of names) {
    const text = await fsp.readFile(path.join(repoPath, name), 'utf8').catch(() => null);
    if (text !== null && text.trim() !== '') {
      return text;
    }
  }
  return null;
}

/**
 * The worktree's diff stat against the base ref (`repos.md` `branch:`) —
 * the committed-on-branch AND uncommitted changes in one stat, what a
 * retry's worker continues from. Null when the base is unset or the
 * worktree does not exist yet (a first run has nothing to show).
 */
export async function worktreeDiffStat(
  git: Pick<TicketsGit, 'run'>,
  worktreePath: string,
  baseRef: string | null,
): Promise<string | null> {
  if (baseRef === null || baseRef.trim() === '') {
    return null;
  }
  try {
    const out = await git.run(worktreePath, ['diff', '--stat', baseRef]);
    const stat = out.trim();
    return stat === '' ? null : stat;
  } catch {
    return null;
  }
}
