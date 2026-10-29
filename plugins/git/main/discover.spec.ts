import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCAN_DEPTH, SCAN_LIMIT, discoverRepos } from './discover';

/**
 * The bounded scan under a parent vault (T-0045): depth bound, the skip
 * rules, `.git`-file worktree markers, registered-root overlap and the
 * per-vault cap — over real folders in a temp directory. Every fixture
 * builds the folder named by a "path" (`a/b` = folders below the vault
 * root); a trailing `!` marks a repository (a `.git` directory, or a
 * `.git` FILE for worktrees).
 */

let root: string;

const folder = async (rel: string, repo = false, gitFile = false): Promise<string> => {
  const dir = join(root, ...rel.split('/'));
  await mkdir(dir, { recursive: true });
  if (repo) {
    if (gitFile) {
      await writeFile(join(dir, '.git'), 'gitdir: ../elsewhere\n');
    } else {
      await mkdir(join(dir, '.git'), { recursive: true });
    }
  }
  return dir;
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'drey-discover-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discoverRepos: depth and markers', () => {
  it('finds repositories down to the depth bound and no further', async () => {
    await folder('depth/a', true);
    await folder('depth/b/c', true);
    await folder('depth/x/y/z', true); // depth 3: still found
    await folder('depth/x2/y/z/w', true); // depth 4: beyond the bound
    expect(SCAN_DEPTH).toBe(3);
    const { repos, clipped } = await discoverRepos(join(root, 'depth'), []);
    expect(repos.map((r) => r.subPath).sort()).toEqual(['a', 'b/c', 'x/y/z']);
    expect(clipped).toBe(false);
  });

  it('records the absolute root beside the vault-relative subPath', async () => {
    const dir = await folder('abs/one', true);
    const { repos } = await discoverRepos(join(root, 'abs'), []);
    expect(repos).toEqual([{ root: dir, subPath: 'one' }]);
  });

  it('counts a .git FILE as the repository marker (linked worktrees)', async () => {
    await folder('worktree/wt', true, true);
    const { repos } = await discoverRepos(join(root, 'worktree'), []);
    expect(repos.map((r) => r.subPath)).toEqual(['wt']);
  });

  it('never descends into a repository it found (no nested surfacing)', async () => {
    await folder('nested/outer', true);
    await folder('nested/outer/inner', true);
    const { repos } = await discoverRepos(join(root, 'nested'), []);
    expect(repos.map((r) => r.subPath)).toEqual(['outer']);
  });
});

describe('discoverRepos: skip rules', () => {
  it('skips dot-directories and node_modules at any depth', async () => {
    await folder('skip/.hidden/repo', true);
    await folder('skip/node_modules/pkg/repo', true);
    await folder('skip/real', true);
    const { repos } = await discoverRepos(join(root, 'skip'), []);
    expect(repos.map((r) => r.subPath)).toEqual(['real']);
  });

  it('skips reserved _-folders at the vault root only', async () => {
    await folder('reserved/_worktrees/drey', true); // root level: machine state
    await folder('reserved/tickets/_meta', true); // below the root: ordinary folder
    const { repos } = await discoverRepos(join(root, 'reserved'), []);
    expect(repos.map((r) => r.subPath)).toEqual(['tickets/_meta']);
  });

  it('does not follow symlinks', async () => {
    const target = await folder('links/target', true);
    await symlink(target, join(root, 'links', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const { repos } = await discoverRepos(join(root, 'links'), []);
    expect(repos.map((r) => r.subPath)).toEqual(['target']);
  });
});

describe('discoverRepos: registered-root overlap', () => {
  it('does not walk the subtree of another registered vault', async () => {
    const other = await folder('overlap/other-vault');
    await folder('overlap/other-vault/deep/repo', true);
    const { repos } = await discoverRepos(join(root, 'overlap'), [other]);
    expect(repos).toEqual([]);
  });

  it('drops a candidate that CONTAINS another registered vault (managed stays authoritative)', async () => {
    await folder('contains/big-repo', true);
    await folder('contains/big-repo/drey-tickets');
    const { repos } = await discoverRepos(join(root, 'contains'), [join(root, 'contains', 'big-repo', 'drey-tickets')]);
    expect(repos).toEqual([]);
  });

  it('keeps a candidate that merely sits BESIDE the registered vault', async () => {
    await folder('beside/repo-a', true);
    await folder('beside/drey-tickets');
    const { repos } = await discoverRepos(join(root, 'beside'), [join(root, 'beside', 'drey-tickets')]);
    expect(repos.map((r) => r.subPath)).toEqual(['repo-a']);
  });
});

describe('discoverRepos: the cap', () => {
  it('clips at the limit, deterministically by subPath, and reports it', async () => {
    expect(SCAN_LIMIT).toBe(25);
    for (let i = 0; i < SCAN_LIMIT + 5; i++) {
      await folder(`cap/repo-${String(i).padStart(3, '0')}`, true);
    }
    const { repos, clipped } = await discoverRepos(join(root, 'cap'), []);
    expect(repos).toHaveLength(SCAN_LIMIT);
    expect(repos[0]?.subPath).toBe('repo-000');
    expect(repos[SCAN_LIMIT - 1]?.subPath).toBe(`repo-${String(SCAN_LIMIT - 1).padStart(3, '0')}`);
    expect(clipped).toBe(true);
  });
});
