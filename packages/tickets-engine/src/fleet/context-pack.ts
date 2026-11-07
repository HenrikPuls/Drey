/**
 * The context pack's file-backed halves (T-0048): the repo's agent
 * instructions and the worktree's diff stat — the reads stay here, out
 * of the pure composers, so the instruction stays testable and the
 * cache-stable prefix (instructions + phase template) stays byte-stable.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { PERSONAS_DIR } from '../core/persona';
import { parseThread } from '../core/persona-thread';
import type { TicketsGit } from '../core/tickets-git';

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

// --- persona memory (ADR-0088, E3) --------------------------------------

/**
 * The persona memory slice of a run's instruction (T-0048 context pack):
 * the tail of the persona's curated `memory.md` — what this agent has
 * already learned on earlier tickets. The caps keep the slice a nudge,
 * not a transcript: at most the last {@link PERSONA_MEMORY_MAX_LINES}
 * lines AND {@link PERSONA_MEMORY_MAX_TOKENS} estimated tokens
 * (~4 characters each — there is no tokenizer at compose time), the
 * newer entries winning the budget. Null when nothing worth including
 * is there, so a persona-less (or memory-less) run's instruction keeps
 * byte-identical prefix stability.
 */
export const PERSONA_MEMORY_MAX_LINES = 20;
export const PERSONA_MEMORY_MAX_TOKENS = 500;

const PERSONA_MEMORY_LEAD =
  'What this agent has learned on previous tickets (its curated memory, newest last) — apply these lessons where they fit:';

export function personaMemorySlice(
  memoryText: string,
  maxLines: number = PERSONA_MEMORY_MAX_LINES,
  maxTokens: number = PERSONA_MEMORY_MAX_TOKENS,
): string | null {
  const lines = memoryText.split(NL);
  while (lines.length > 0 && lines[0]!.trim() === '') {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return null;
  }
  const picked: string[] = [];
  let tokens = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === '') {
      continue; // separators carry no lesson
    }
    const lineTokens = Math.max(1, Math.ceil(line.length / 4));
    if (picked.length >= maxLines || tokens + lineTokens > maxTokens) {
      break;
    }
    picked.unshift(line);
    tokens += lineTokens;
  }
  // The file's own `# Memory` header is not a lesson either.
  while (picked.length > 0 && picked[0]!.trimStart().startsWith('#')) {
    picked.shift();
  }
  return picked.length === 0 ? null : picked.join(NL);
}

/** The instruction's `## Skills` section for a persona's skills (D-46), or null when it carries none. */
export function personaSkillsSection(skills: readonly { readonly name: string; readonly text: string }[] | undefined): string | null {
  if (skills === undefined || skills.length === 0) {
    return null;
  }
  return [`## Skills`, `Your persona's skills. Use them where they apply to this step.`, ...skills.map((s) => `### ${s.name}${NL}${NL}${s.text}`)].join(`${NL}${NL}`);
}

/** The instruction's `## Memory` section for one persona's memory text, or null when empty. */
export function personaMemorySection(memoryText: string): string | null {
  const slice = personaMemorySlice(memoryText);
  if (slice === null) {
    return null;
  }
  return `## Memory${NL}${NL}${PERSONA_MEMORY_LEAD}${NL}${NL}${slice}`;
}

/**
 * One persona's memory file from the tickets vault — the same plain-fs
 * vault read the repo instructions use. Null when the file is absent or
 * blank (an empty section would not change the run's behaviour, so the
 * instruction is left untouched). The id is validated before it ever
 * reaches a path join.
 */
export async function readPersonaMemory(vaultPath: string, personaId: string): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(personaId)) {
    return null;
  }
  const text = await fsp
    .readFile(path.join(vaultPath, PERSONAS_DIR, personaId, 'memory.md'), 'utf8')
    .catch(() => null);
  return text !== null && text.trim() !== '' ? text : null;
}

// --- persona coaching (U4, concept §4.5) ------------------------------------

/**
 * The persona coaching slice (U4, concept §4.5): the LAST
 * {@link PERSONA_COACHING_MAX_LINES} owner messages of the persona's
 * thread.md — what the owner taught in direct conversation — newest
 * first, so the freshest correction is the first thing the instruction
 * carries. Null when the thread holds no messages, so a persona-less (or
 * un-coached) run's instruction stays byte-identical.
 */
export const PERSONA_COACHING_MAX_LINES = 5;

const PERSONA_COACHING_LEAD =
  'Coaching (owner, letzter zuerst) — was der Owner im direkten Gespräch beigebracht hat; anwenden, wo es passt:';

export function personaCoachingSection(threadText: string): string | null {
  const messages = parseThread(threadText);
  const last = messages.slice(-PERSONA_COACHING_MAX_LINES).reverse();
  if (last.length === 0) {
    return null;
  }
  const lines = last.map((m) => `- '${m.at}' ${m.role} — ${m.text}`);
  return `## Coaching${NL}${NL}${PERSONA_COACHING_LEAD}${NL}${NL}${lines.join(NL)}`;
}
