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
 * The work repo's agent instructions — the stable in-repo prefix every
 * phase instruction opens with. The repo's
 * `instructions:` file (req-79) first — a short brief for unattended
 * runs instead of the pair-programming rules every model call would
 * otherwise carry — then `CLAUDE.md`, then `AGENTS.md`; null when the
 * repo carries none of them (or the checkout is unreachable). The
 * configured file is verbatim (the owner chose it for exactly this); the
 * fallbacks are the pair-programming rules of the whole repo (Drey's is
 * 50 KB, re-sent with every model call of the run) and are cut at
 * `FALLBACK_INSTRUCTIONS_CAP` with a pointer to search the file instead.
 */
export const FALLBACK_INSTRUCTIONS_CAP = 16 * 1024;
const NL = String.fromCharCode(10);

export async function readRepoInstructions(repoPath: string, configured: string | null = null): Promise<string | null> {
  const names = configured !== null ? [configured, 'CLAUDE.md', 'AGENTS.md'] : ['CLAUDE.md', 'AGENTS.md'];
  for (const name of names) {
    const text = await fsp.readFile(path.join(repoPath, name), 'utf8').catch(() => null);
    if (text !== null && text.trim() !== '') {
      if (name === configured || Buffer.byteLength(text, 'utf8') <= FALLBACK_INSTRUCTIONS_CAP) {
        return text;
      }
      const head = text.slice(0, FALLBACK_INSTRUCTIONS_CAP);
      const cut = head.lastIndexOf(NL);
      return (
        `${(cut > FALLBACK_INSTRUCTIONS_CAP / 2 ? head.slice(0, cut) : head).trimEnd()}${NL}${NL}` +
        `[${name} continues — search it for the topic at hand instead of reading it whole: it is ` +
        `${Math.round(Buffer.byteLength(text, 'utf8') / 1024)} KB.]`
      );
    }
  }
  return null;
}

/**
 * What the branch holds beyond the base ref (`repos.md` `branch:`), the
 * state a retry's worker continues from: the stat of the commits made
 * since the branch left the base (`base...HEAD`, the merge-base form),
 * then the uncommitted paths. The old `git diff --stat <base>` compared
 * against the base's CURRENT tip, so once the base moved on every
 * upstream change read as the worker's own deletions. Null when the
 * base is unset, the worktree does not exist yet (a first run has
 * nothing to show) or nothing differs.
 */
export async function worktreeDiffStat(
  git: Pick<TicketsGit, 'run'>,
  worktreePath: string,
  baseRef: string | null,
): Promise<string | null> {
  if (baseRef === null || baseRef.trim() === '') {
    return null;
  }
  const sections: string[] = [];
  try {
    const committed = (await git.run(worktreePath, ['diff', '--stat', `${baseRef}...HEAD`])).trim();
    if (committed !== '') {
      sections.push(`Committed on the branch:\n${committed}`);
    }
    const uncommitted = (await git.run(worktreePath, ['status', '--short'])).trim();
    if (uncommitted !== '') {
      sections.push(`Uncommitted:\n${uncommitted}`);
    }
  } catch {
    return null;
  }
  return sections.length === 0 ? null : sections.join('\n\n');
}
