import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanRepoFolder, type RepoScanExec } from './repos-scan';

/**
 * "Add from folder" (req-72): the folder itself and its non-hidden
 * subdirectories are probed for git repositories — `.git` present, then
 * origin and branch through the git seam (faked here; real git is
 * worktrees.spec's round).
 */
describe('scanRepoFolder', () => {
  let root = '';

  /** A fake git seam: answers from a fixed table per repo. */
  const execWith = (remotes: Record<string, { url: string; branch: string }>): RepoScanExec => async (cwd, args) => {
    const known = remotes[path.basename(cwd)];
    if (known === undefined) {
      throw new Error(`not a repo: ${cwd}`);
    }
    if (args[0] === 'remote') {
      return `${known.url}\n`;
    }
    return `${known.branch}\n`;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'drey-scan-'));
    // The folder itself is a repo; one subfolder is one too; the rest is not.
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, 'lariscus', '.git'), { recursive: true });
    await mkdir(path.join(root, 'notes')); // no .git — no candidate
    await mkdir(path.join(root, '.hidden', '.git'), { recursive: true }); // hidden — skipped
    await mkdir(path.join(root, '_worktrees', '.git'), { recursive: true }); // underscore — skipped
    await writeFile(path.join(root, 'file.txt'), 'x');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds the folder and its visible subfolders, hidden and underscore ones skipped', async () => {
    const remotes = {
      [path.basename(root)]: { url: 'https://example.invalid/drey.git', branch: 'main' },
      lariscus: { url: 'https://example.invalid/lariscus.git', branch: 'develop' },
    };
    const { candidates, skipped } = await scanRepoFolder(root, execWith(remotes));
    expect(skipped).toEqual([]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      name: path.basename(root),
      url: 'https://example.invalid/drey.git',
      branch: 'main',
      path: root,
    });
    expect(candidates[1]).toMatchObject({ name: 'lariscus', url: 'https://example.invalid/lariscus.git', branch: 'develop' });
  });

  it('a repo without an origin remote is still a candidate, url null', async () => {
    const { candidates } = await scanRepoFolder(root, execWith({}));
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ url: null, branch: null });
  });
});
