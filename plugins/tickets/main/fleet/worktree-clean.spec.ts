import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TicketsGit } from '../tickets-git';
import type { RepoRef } from '../../shared/tickets';
import { legacyWorktreeBase, WORKTREES_DIR } from './worktree-home';
import { cleanWorktrees, listOrphans, removeWorktree } from './worktree-clean';

/**
 * Worktree cleanup (T-0044, ADR-0080) against the installed git — the
 * behaviour *is* git state (registration, admin entries under
 * `<repo>/.git/worktrees/`, the dirty refusal), so every case builds
 * the real shapes in temp repos (the worktrees.spec.ts pattern).
 */

const execFileAsync = promisify(execFile);

/** Plain git with a commit identity, outside any seam. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args], {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
  });
  return stdout;
}

describe('removeWorktree (real git)', () => {
  let baseDir = '';
  let repo = '';
  let home = '';

  beforeEach(async () => {
    // Canonical from the start (the runner's 8.3 `RUNNER~1` temp vs git's
    // long paths — see worktrees.spec.ts); the alias case is the junction
    // test in the cleanWorktrees describe.
    baseDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-wtc-')));
    repo = path.join(baseDir, 'repo');
    home = path.join(baseDir, 'vault', WORKTREES_DIR);
    await fsp.mkdir(repo);
    await git(repo, ['init', '-b', 'main']);
    await fsp.writeFile(path.join(repo, 'file.txt'), 'one\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'initial']);
  });

  afterEach(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const fleetGit = (): TicketsGit => new TicketsGit(() => 'git');
  const addWorktree = async (ticket: string): Promise<string> => {
    const wt = path.join(home, ticket);
    await git(repo, ['worktree', 'add', '-b', `t/${ticket}`, wt]);
    return wt;
  };

  it('removes a clean worktree and its admin entry', async () => {
    const wt = await addWorktree('T-0001');
    await expect(fsp.stat(wt)).resolves.toBeDefined();

    const outcome = await removeWorktree(fleetGit(), repo, wt);
    expect(outcome).toEqual({ ok: true });
    await expect(fsp.stat(wt)).rejects.toThrow();
    expect(await fsp.readdir(path.join(repo, '.git', 'worktrees')).catch(() => [] as string[])).toEqual([]);
  });

  it('refuses a dirty worktree with its porcelain status', async () => {
    const wt = await addWorktree('T-0001');
    await fsp.writeFile(path.join(wt, 'uncommitted.txt'), 'half-finished\n');

    const outcome = await removeWorktree(fleetGit(), repo, wt);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.dirty === true) {
      expect(outcome.status).toContain('?? uncommitted.txt');
    } else {
      throw new Error('expected the dirty refusal');
    }
    await expect(fsp.stat(wt)).resolves.toBeDefined();
  });

  it('force removes a dirty worktree after the owner confirmed', async () => {
    const wt = await addWorktree('T-0001');
    await fsp.writeFile(path.join(wt, 'uncommitted.txt'), 'half-finished\n');

    const outcome = await removeWorktree(fleetGit(), repo, wt, { force: true });
    expect(outcome).toEqual({ ok: true });
    await expect(fsp.stat(wt)).rejects.toThrow();
  });

  it('unlinks the link: junctions so the removal leaves no folder behind (the poisoned-path trap)', async () => {
    // git's worktree removal leaves junctions behind; a leftover folder at
    // the path poisons the next prepare (worktrees.spec.ts's walk-up trap).
    // The junction is git-ignored in the worktree — the req-56 rule the
    // real repos follow (a link git would see is never made).
    await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'ignore node_modules']);
    const wt = await addWorktree('T-0001');
    const shared = path.join(baseDir, 'shared');
    await fsp.mkdir(shared);
    await fsp.writeFile(path.join(shared, 'binary.txt'), 'still here\n');
    await fsp.symlink(shared, path.join(wt, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

    const outcome = await removeWorktree(fleetGit(), repo, wt, { links: ['node_modules'] });
    expect(outcome).toEqual({ ok: true });
    await expect(fsp.stat(wt)).rejects.toThrow();
    expect(await fsp.readdir(path.join(repo, '.git', 'worktrees')).catch(() => [] as string[])).toEqual([]);
    // The delete never reached through the link.
    await expect(fsp.readFile(path.join(shared, 'binary.txt'), 'utf8')).resolves.toBe('still here\n');
  });

  it('errors on a folder without worktree registration', async () => {
    const plain = path.join(home, 'T-0001');
    await fsp.mkdir(plain, { recursive: true });
    await fsp.writeFile(path.join(plain, 'stray.txt'), 'not a worktree\n');

    const outcome = await removeWorktree(fleetGit(), repo, plain);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect('error' in outcome && outcome.error).toContain('cannot be inspected');
    }
    await expect(fsp.stat(plain)).resolves.toBeDefined();
  });

  it('errors on a registration whose tree no longer answers', async () => {
    const wt = await addWorktree('T-0001');
    await fsp.rm(wt, { recursive: true, force: true });

    const outcome = await removeWorktree(fleetGit(), repo, wt);
    expect(outcome.ok).toBe(false);
  });
});

describe('cleanWorktrees (real git)', () => {
  let baseDir = '';
  let repo = '';
  let vault = '';
  let fleetRoot = '';
  let repoRef: RepoRef;

  beforeEach(async () => {
    // Canonical from the start (the runner's 8.3 `RUNNER~1` temp vs git's
    // long paths — see worktrees.spec.ts); the alias case is the junction
    // test below.
    baseDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-wtcx-')));
    repo = path.join(baseDir, 'repo');
    vault = path.join(baseDir, 'vault');
    fleetRoot = path.join(baseDir, 'fleet-root');
    await fsp.mkdir(repo);
    await git(repo, ['init', '-b', 'main']);
    await fsp.writeFile(path.join(repo, 'file.txt'), 'one\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'initial']);
    repoRef = {
      name: 'drey',
      url: 'https://example.test/drey.git',
      branch: 'main',
      policy: null,
      path: repo,
      worker: null,
      worktrees: null,
    };
  });

  afterEach(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const fleetGit = (): TicketsGit => new TicketsGit(() => 'git');
  /** Report paths come from porcelain (forward slashes) — compare folded. */
  const win = (p: string): string => p.replaceAll('\\', '/');
  const addAt = async (wt: string, branch: string): Promise<string> => {
    await fsp.mkdir(path.dirname(wt), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', branch, wt]);
    return wt;
  };
  const homeWt = (ticket: string): string => path.join(vault, WORKTREES_DIR, ticket);
  const legacyWt = (ticket: string): string => path.join(legacyWorktreeBase(fleetRoot), `drey-${ticket}`);
  const adminNames = async (): Promise<string[]> =>
    (await fsp.readdir(path.join(repo, '.git', 'worktrees')).catch(() => [] as string[])).sort();

  it('removes home and legacy entries, skips protected paths, prunes per repo', async () => {
    const gone1 = await addAt(homeWt('T-0001'), 't/T-0001');
    const gone2 = await addAt(legacyWt('T-0002'), 't/T-0002');
    const kept = await addAt(homeWt('T-0003'), 't/T-0003');

    const report = await cleanWorktrees(fleetGit(), {
      repos: [repoRef],
      vaultPath: vault,
      fleetRoot,
      protectedPaths: [kept],
    });
    expect(report.removed.map(win).sort()).toEqual([win(gone1), win(gone2)].sort());
    expect(report.keptDirty).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.prunedRepos).toEqual([repo]);
    // The protected tree and its admin entry survive; the removed ones'
    // admin entries are gone (the prune did its job).
    await expect(fsp.stat(kept)).resolves.toBeDefined();
    expect(await adminNames()).toEqual([path.basename(kept)]);
  });

  it.skipIf(process.platform !== 'win32')(
    'removes worktrees when the vault path is an alias (git reports the canonical path)',
    async () => {
      // A junction reproduces the alias shape of the GitHub Windows
      // runner's 8.3 temp dir on any checkout: cleanup is asked through
      // the alias while git lists the canonical paths.
      const gone = await addAt(homeWt('T-0001'), 't/T-0001');
      const aliasVault = `${vault}-alias`;
      await execFileAsync('cmd', ['/c', 'mklink', '/J', aliasVault, vault], { windowsHide: true });
      try {
        const report = await cleanWorktrees(fleetGit(), {
          repos: [repoRef],
          vaultPath: aliasVault,
          fleetRoot,
          protectedPaths: [],
        });
        expect(report.removed).toHaveLength(1);
        expect(report.keptDirty).toEqual([]);
        expect(report.failed).toEqual([]);
        expect(await adminNames()).toEqual([]);
        await expect(fsp.stat(gone)).rejects.toThrow();
      } finally {
        await execFileAsync('cmd', ['/c', 'rmdir', aliasVault], { windowsHide: true });
      }
    },
  );

  it('drops the legacy base folder when it is empty afterwards', async () => {
    await addAt(legacyWt('T-0002'), 't/T-0002');

    const report = await cleanWorktrees(fleetGit(), {
      repos: [repoRef],
      vaultPath: vault,
      fleetRoot,
      protectedPaths: [],
    });
    expect(report.removed).toHaveLength(1);
    await expect(fsp.stat(legacyWorktreeBase(fleetRoot))).rejects.toThrow();
  });

  it('keeps dirty trees and reports them — nothing is destroyed', async () => {
    const dirty = await addAt(homeWt('T-0001'), 't/T-0001');
    await fsp.writeFile(path.join(dirty, 'uncommitted.txt'), 'half-finished\n');

    const report = await cleanWorktrees(fleetGit(), {
      repos: [repoRef],
      vaultPath: vault,
      fleetRoot,
      protectedPaths: [],
    });
    expect(report.removed).toEqual([]);
    expect(report.keptDirty.map(win)).toEqual([win(dirty)]);
    await expect(fsp.readFile(path.join(dirty, 'uncommitted.txt'), 'utf8')).resolves.toBe('half-finished\n');
  });

  it('never touches the repo itself or trees outside the bases', async () => {
    const outside = await addAt(path.join(baseDir, 'elsewhere', 'T-0001'), 't/T-0001');

    const report = await cleanWorktrees(fleetGit(), {
      repos: [repoRef],
      vaultPath: vault,
      fleetRoot,
      protectedPaths: [],
    });
    expect(report.removed).toEqual([]);
    expect(report.keptDirty).toEqual([]);
    await expect(fsp.stat(outside)).resolves.toBeDefined();
    // The main checkout still answers.
    expect((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
  });

  it('reports a repo whose git fails and continues with the rest', async () => {
    const gone = await addAt(homeWt('T-0001'), 't/T-0001');
    const broken: RepoRef = { ...repoRef, path: path.join(baseDir, 'missing') };

    const report = await cleanWorktrees(fleetGit(), {
      repos: [broken, repoRef],
      vaultPath: vault,
      fleetRoot,
      protectedPaths: [],
    });
    expect(report.removed.map(win)).toEqual([win(gone)]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.error).toContain('worktree list failed');
    expect(report.prunedRepos).toEqual([repo]);
  });

  describe('unregistered leftovers (req-68)', () => {
    /** An unregistered folder holding a junction into the repo — what an
     *  older removal left behind (`junction` is a dir symlink off win32). */
    const leftoverAt = async (folder: string): Promise<string> => {
      await fsp.mkdir(folder, { recursive: true });
      await fsp.symlink(repo, path.join(folder, '.tools'), 'junction');
      return folder;
    };

    it('sweeps link-only folders, never following the links', async () => {
      const legacy = await leftoverAt(legacyWt('T-0007'));
      const home = await leftoverAt(homeWt('T-0008'));
      await fsp.mkdir(legacyWt('T-0009'), { recursive: true });

      const report = await cleanWorktrees(fleetGit(), {
        repos: [repoRef],
        vaultPath: vault,
        fleetRoot,
        protectedPaths: [],
      });
      expect(report.leftovers.map(win).sort()).toEqual([win(legacy), win(home), win(legacyWt('T-0009'))].sort());
      expect(report.removed).toEqual([]);
      await expect(fsp.stat(legacyWorktreeBase(fleetRoot))).rejects.toThrow();
      await expect(fsp.stat(home)).rejects.toThrow();
      // The junction's target is untouched.
      await expect(fsp.readFile(path.join(repo, 'file.txt'), 'utf8')).resolves.toBe('one\n');
    });

    it('keeps folders with real content, protected paths and stale move-asides', async () => {
      const real = await leftoverAt(legacyWt('T-0001'));
      await fsp.writeFile(path.join(real, 'notes.txt'), 'keep\n');
      const guarded = await leftoverAt(legacyWt('T-0002'));
      const stale = await leftoverAt(path.join(legacyWorktreeBase(fleetRoot), 'drey-T-0003.stale-20261019T010203'));

      const report = await cleanWorktrees(fleetGit(), {
        repos: [repoRef],
        vaultPath: vault,
        fleetRoot,
        protectedPaths: [guarded],
      });
      expect(report.leftovers).toEqual([]);
      await expect(fsp.readFile(path.join(real, 'notes.txt'), 'utf8')).resolves.toBe('keep\n');
      await expect(fsp.lstat(path.join(real, '.tools'))).resolves.toBeDefined();
      await expect(fsp.stat(guarded)).resolves.toBeDefined();
      await expect(fsp.stat(stale)).resolves.toBeDefined();
    });

    it('leaves registered trees to git and the home base alone under legacyOnly', async () => {
      const live = await addAt(legacyWt('T-0001'), 't/T-0001');
      await fsp.writeFile(path.join(live, 'dirty.txt'), 'x\n');
      const home = await leftoverAt(homeWt('T-0002'));

      const report = await cleanWorktrees(fleetGit(), {
        repos: [repoRef],
        vaultPath: vault,
        fleetRoot,
        protectedPaths: [],
        legacyOnly: true,
      });
      expect(report.keptDirty.map(win)).toEqual([win(live)]);
      expect(report.leftovers).toEqual([]);
      await expect(fsp.stat(home)).resolves.toBeDefined();
    });
  });
});

describe('listOrphans', () => {
  let baseDir = '';
  let base = '';

  beforeEach(async () => {
    baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-wto-'));
    base = path.join(baseDir, 'vault', WORKTREES_DIR);
    for (const name of ['T-0001', 'T-0002', 'T-0003.stale-20261019T010203']) {
      await fsp.mkdir(path.join(base, name), { recursive: true });
    }
  });

  afterEach(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true });
  });

  it('lists folders no run names, skipping stale move-asides and dot entries', async () => {
    const named = path.join(base, 'T-0001');
    await fsp.mkdir(path.join(base, '.hidden'));
    const orphans = await listOrphans([base], [named]);
    expect(orphans).toEqual([path.join(base, 'T-0002')]);
  });

  it('folds case and slash direction on win32 (the compare discipline)', async () => {
    const named = path.join(base, 'T-0001').replaceAll('\\', '/').toUpperCase();
    const orphans = await listOrphans([base], [named]);
    // On win32 the upper-cased name is the same path; elsewhere it is
    // an unknown folder and therefore an orphan.
    expect(orphans).toEqual(process.platform === 'win32' ? [path.join(base, 'T-0002')] : [
      path.join(base, 'T-0002'),
      path.join(base, 'T-0001'),
    ].sort());
  });

  it('an absent base is no orphans, never an error', async () => {
    const orphans = await listOrphans([path.join(baseDir, 'absent')], []);
    expect(orphans).toEqual([]);
  });
});
