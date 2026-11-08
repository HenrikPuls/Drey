import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FALLBACK_INSTRUCTIONS_CAP, personaMemorySection, personaMemorySlice, readPersonaMemory, readRepoInstructions, worktreeDiffStat } from './context-pack';

/**
 * Which file opens a run's brief (T-0048, req-79): the repo's
 * `instructions:` file when set and present, else `CLAUDE.md`, else
 * `AGENTS.md` — over a real checkout folder (temp dir).
 */

let repoDir = '';

beforeEach(async () => {
  repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-context-pack-'));
});

afterEach(async () => {
  await fsp.rm(repoDir, { recursive: true, force: true });
});

async function put(rel: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(path.join(repoDir, rel)), { recursive: true });
  await fsp.writeFile(path.join(repoDir, rel), text, 'utf8');
}

describe('readRepoInstructions', () => {
  it('prefers the configured instructions file over CLAUDE.md (req-79)', async () => {
    await put('CLAUDE.md', '# Pair-programming rules');
    await put('docs/agents/fleet-worker.md', '# Fleet worker orientation');
    expect(await readRepoInstructions(repoDir, 'docs/agents/fleet-worker.md')).toBe('# Fleet worker orientation');
  });

  it('cuts an oversized fallback file at the cap and points at searching it, but never the configured file', async () => {
    const big = Array.from({ length: 2_000 }, (_, i) => `rule ${i}: keep things tidy and explicit`).join(String.fromCharCode(10));
    await put('CLAUDE.md', big);
    const cut = (await readRepoInstructions(repoDir)) as string;
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThan(FALLBACK_INSTRUCTIONS_CAP + 400);
    expect(cut).toContain('rule 0:');
    expect(cut).not.toContain('rule 1999:');
    expect(cut).toContain('CLAUDE.md continues — search it');
    await put('docs/agents/fleet-worker.md', big);
    expect(await readRepoInstructions(repoDir, 'docs/agents/fleet-worker.md')).toBe(big);
  });

  it('falls back to CLAUDE.md when the configured file is missing or blank', async () => {
    await put('CLAUDE.md', '# Pair-programming rules');
    expect(await readRepoInstructions(repoDir, 'docs/agents/fleet-worker.md')).toBe('# Pair-programming rules');
    await put('docs/agents/fleet-worker.md', '  \n');
    expect(await readRepoInstructions(repoDir, 'docs/agents/fleet-worker.md')).toBe('# Pair-programming rules');
  });

  it('without a configured file reads CLAUDE.md, then AGENTS.md, else null', async () => {
    expect(await readRepoInstructions(repoDir, null)).toBeNull();
    await put('AGENTS.md', '# Agents');
    expect(await readRepoInstructions(repoDir, null)).toBe('# Agents');
    await put('CLAUDE.md', '# Claude');
    expect(await readRepoInstructions(repoDir, null)).toBe('# Claude');
  });
});

describe('worktreeDiffStat — what the branch holds beyond the base', () => {
  const git = (answers: Record<string, string | Error>) => ({
    run: async (_cwd: string, args: readonly string[]): Promise<string> => {
      const answer = answers[args.join(' ')];
      if (answer === undefined) {
        throw new Error(`unexpected git ${args.join(' ')}`);
      }
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  });

  it('diffs against the merge-base (three dots), then lists the uncommitted paths', async () => {
    const out = await worktreeDiffStat(
      git({ 'diff --stat main...HEAD': ' a.ts | 2 +-\n', 'status --short': ' M b.ts\n' }),
      'W:/wt',
      'main',
    );
    expect(out).toBe('Committed on the branch:\na.ts | 2 +-\n\nUncommitted:\nM b.ts');
  });

  it('is null without a base, without differences or when git fails', async () => {
    expect(await worktreeDiffStat(git({}), 'W:/wt', null)).toBeNull();
    expect(await worktreeDiffStat(git({ 'diff --stat main...HEAD': '', 'status --short': '' }), 'W:/wt', 'main')).toBeNull();
    expect(await worktreeDiffStat(git({ 'diff --stat main...HEAD': new Error('no worktree') }), 'W:/wt', 'main')).toBeNull();
  });
});

describe('persona memory slice (ADR-0088, E3)', () => {
  it('is null for empty or blank memory text — persona-less runs keep identical instruction bytes', () => {
    expect(personaMemorySlice('')).toBeNull();
    expect(personaMemorySlice('   \n\n')).toBeNull();
    expect(personaMemorySection('')).toBeNull();
  });

  it('takes the newest tail, at most 20 lines, chronological order kept', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `- lesson ${i + 1}`);
    const slice = personaMemorySlice(`# Memory\n\n${lines.join('\n')}\n`);
    expect(slice).toBe(lines.slice(-20).join('\n'));
  });

  it('keeps a short file whole, without the # Memory header line', () => {
    const text = '# Memory\n\n- only lesson\n';
    expect(personaMemorySlice(text)).toBe('- only lesson');
  });

  it('cuts at the token budget even inside the line cap — the oldest oversized line goes', () => {
    const huge = `- ${'x'.repeat(2400)}`; // ~600 estimated tokens alone
    const slice = personaMemorySlice([huge, '- fresh and short'].join('\n'));
    expect(slice).toBe('- fresh and short');
  });

  it('skips blank separator lines in the picked slice', () => {
    const text = '- one\n\n- two\n';
    expect(personaMemorySlice(text)).toBe('- one\n- two');
  });

  it('composes the ## Memory section with the one-line explanation', () => {
    const section = personaMemorySection('- 2026-11-01 · T-0102 · handed-over');
    expect(section).toContain('## Memory');
    expect(section).toContain('learned on previous tickets');
    expect(section!.trimEnd().endsWith('- 2026-11-01 · T-0102 · handed-over')).toBe(true);
  });
});

describe('readPersonaMemory — the vault-side read', () => {
  it('reads the persona memory file from the tickets vault', async () => {
    await put('tickets/_meta/personas/pia/memory.md', '# Memory\n\n- lesson\n');
    expect(await readPersonaMemory(repoDir, 'pia')).toBe('# Memory\n\n- lesson\n');
  });

  it('is null when the file is absent or blank', async () => {
    expect(await readPersonaMemory(repoDir, 'pia')).toBeNull();
    await put('tickets/_meta/personas/pia/memory.md', '  \n');
    expect(await readPersonaMemory(repoDir, 'pia')).toBeNull();
  });

  it('refuses ids that are no persona ids before they reach the path', async () => {
    expect(await readPersonaMemory(repoDir, '../escape')).toBeNull();
    expect(await readPersonaMemory(repoDir, 'a/b')).toBeNull();
  });
});

