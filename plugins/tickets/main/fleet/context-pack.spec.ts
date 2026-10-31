import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepoInstructions } from './context-pack';

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
