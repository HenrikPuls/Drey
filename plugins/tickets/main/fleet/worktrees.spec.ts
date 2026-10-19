import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketsGit, type GitExecFn } from '../tickets-git';
import { newTicketFileText } from '../ticket-files';
import type { ProviderAdapter, WorkerHandle } from './providers';
import type { RunInfo, RunRequest } from './protocol';
import { RunSupervisor, type RunSupervisorDeps } from './runs';
import { parseWorktreePorcelain, prepareWorktree } from './worktrees';

/**
 * The worktree state machine (T-0047) against the installed git — the
 * behaviour *is* git state, so every case constructs the real leftover
 * shapes (removed directory, deleted admin `gitdir` file, deleted
 * `<wt>/.git`, locked, mid-rebase, mid-merge) in temp repos. The
 * supervisor wiring at the bottom mirrors runs.spec.ts's seams (specs
 * never import from other specs).
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

const BRANCH = 't/T-0091';
/** Frozen clock — makes the `.stale-<stamp>` name and its collision
 *  suffixes deterministic. */
const frozen = (): Date => new Date('2026-10-19T01:02:03Z');

describe('parseWorktreePorcelain', () => {
  it('parses healthy, detached, locked (with reason) and prunable entries', () => {
    const recorded = [
      'worktree C:/repos/drey',
      'HEAD 0000000000000000000000000000000000000001',
      'branch refs/heads/main',
      '',
      'worktree C:/wt/a',
      'HEAD 0000000000000000000000000000000000000002',
      'detached',
      '',
      'worktree C:/wt/b',
      'HEAD 0000000000000000000000000000000000000003',
      'branch refs/heads/t/T-0091',
      'locked rebase in progress',
      '',
      'worktree C:/wt/c',
      'HEAD 0000000000000000000000000000000000000004',
      'branch refs/heads/t/T-0092',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    const entries = parseWorktreePorcelain(recorded);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({
      path: 'C:/repos/drey',
      branch: 'refs/heads/main',
      detached: false,
      locked: false,
      prunable: false,
    });
    expect(entries[1]).toEqual({
      path: 'C:/wt/a',
      branch: null,
      detached: true,
      locked: false,
      prunable: false,
    });
    expect(entries[2]).toEqual({
      path: 'C:/wt/b',
      branch: 'refs/heads/t/T-0091',
      detached: false,
      locked: true,
      prunable: false,
    });
    expect(entries[3]).toEqual({
      path: 'C:/wt/c',
      branch: 'refs/heads/t/T-0092',
      detached: false,
      locked: false,
      prunable: true,
    });
  });
});

describe('prepareWorktree (real git)', () => {
  let baseDir = '';
  let repo = '';
  let worktreePath = '';
  /** The worktree's admin dir name inside `<repo>/.git/worktrees/`. */
  let adminName = '';

  beforeEach(async () => {
    baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-wt-'));
    repo = path.join(baseDir, 'repo');
    await fsp.mkdir(repo);
    await git(repo, ['init', '-b', 'main']);
    await fsp.writeFile(path.join(repo, 'file.txt'), 'one\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'initial']);
    // A nested path on purpose: preparation must create the parent.
    worktreePath = path.join(baseDir, 'fleet-root', 'worktrees', 'repo-T-0091');
    adminName = path.basename(worktreePath);
  });

  afterEach(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const fleetGit = (): TicketsGit => new TicketsGit(() => 'git');
  const req = (overrides: Partial<Pick<RunRequest, 'repoPath' | 'branch' | 'baseRef'>> = {}) => ({
    repoPath: repo,
    branch: BRANCH,
    baseRef: 'main',
    ...overrides,
  });
  const headOf = async (dir: string): Promise<string> =>
    (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const listing = async (): Promise<string> => await git(repo, ['worktree', 'list', '--porcelain']);
  const siblings = async (): Promise<readonly string[]> => await fsp.readdir(path.dirname(worktreePath));

  it('creates a fresh worktree from the base ref when nothing exists', async () => {
    const result = await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    expect(result).toEqual({ outcome: 'created', sessionInvalidated: false, movedTo: null });
    expect(await headOf(worktreePath)).toBe(BRANCH);
    await expect(git(repo, ['rev-parse', '--verify', `refs/heads/${BRANCH}`])).resolves.toBeDefined();
  });

  it('creates over an existing empty directory', async () => {
    await fsp.mkdir(worktreePath, { recursive: true });
    const result = await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    expect(result).toEqual({ outcome: 'created', sessionInvalidated: false, movedTo: null });
    expect(await headOf(worktreePath)).toBe(BRANCH);
  });

  it('reuses a registered worktree and its dirty state survives (retry keeps the half-finished work)', async () => {
    await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    await fsp.writeFile(path.join(worktreePath, 'file.txt'), 'edited\n');
    await fsp.writeFile(path.join(worktreePath, 'untracked.txt'), 'new\n');

    const result = await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    expect(result).toEqual({ outcome: 'reused', sessionInvalidated: false, movedTo: null });
    await expect(fsp.readFile(path.join(worktreePath, 'file.txt'), 'utf8')).resolves.toBe('edited\n');
    await expect(fsp.readFile(path.join(worktreePath, 'untracked.txt'), 'utf8')).resolves.toBe('new\n');
    expect(await siblings()).toEqual([adminName]);
  });

  it.skipIf(process.platform !== 'win32')(
    'reuses a worktree reached through a path alias (git reports the canonical path)',
    async () => {
      // The GitHub Windows runner's temp dir is an 8.3 short name
      // (`RUNNER~1` for `runneradmin`): git registers and reports the
      // canonical long path, so the requested path is an alias of the
      // listed one. A junction reproduces that shape on any checkout.
      const aliasBase = `${baseDir}-alias`;
      await execFileAsync('cmd', ['/c', 'mklink', '/J', aliasBase, baseDir], { windowsHide: true });
      try {
        const aliasPath = path.join(aliasBase, 'fleet-root', 'worktrees', 'repo-T-0091');
        await prepareWorktree(fleetGit(), req(), aliasPath, frozen);
        await fsp.writeFile(path.join(aliasPath, 'untracked.txt'), 'kept\n');

        const result = await prepareWorktree(fleetGit(), req(), aliasPath, frozen);
        expect(result).toEqual({ outcome: 'reused', sessionInvalidated: false, movedTo: null });
        await expect(fsp.readFile(path.join(aliasPath, 'untracked.txt'), 'utf8')).resolves.toBe(
          'kept\n',
        );
        expect(await siblings()).toEqual([adminName]);
      } finally {
        await execFileAsync('cmd', ['/c', 'rmdir', aliasBase], { windowsHide: true });
      }
    },
  );

  it('re-creates a removed worktree with the branch history intact', async () => {
    await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    await git(worktreePath, ['commit', '--allow-empty', '-m', 'worktree work']);
    const tip = (await git(repo, ['rev-parse', BRANCH])).trim();
    await fsp.rm(worktreePath, { recursive: true, force: true });

    const result = await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    expect(result).toEqual({ outcome: 'created', sessionInvalidated: false, movedTo: null });
    expect((await git(repo, ['rev-parse', BRANCH])).trim()).toBe(tip);
    expect(await headOf(worktreePath)).toBe(BRANCH);
  });

  // --- the re-run trap (T-0044): the branch checked out elsewhere ---

  /** A leftover registration of the branch somewhere else — the settled
   *  ticket's checkout in another base (the legacy fleet root). */
  const legacyConflict = async (): Promise<string> => {
    const legacy = path.join(baseDir, 'legacy-root', 'worktrees', 'repo-T-0091');
    await prepareWorktree(fleetGit(), req(), legacy, frozen);
    return legacy;
  };

  it('removes a clean conflicting registration when it is not live, then creates', async () => {
    const legacy = await legacyConflict();

    const result = await prepareWorktree(fleetGit(), req(), worktreePath, frozen, () => false);
    expect(result).toEqual({ outcome: 'created', sessionInvalidated: false, movedTo: null });
    expect(await headOf(worktreePath)).toBe(BRANCH);
    // The conflicting registration and its folder are gone (real git
    // remove, branch untouched).
    expect(await listing()).not.toContain(legacy.replaceAll('\\', '/'));
    await expect(fsp.stat(legacy)).rejects.toThrow();
    expect((await git(repo, ['rev-parse', BRANCH])).trim()).toBeDefined();
  });

  it('refuses descriptively when the conflicting registration is live', async () => {
    const legacy = await legacyConflict();

    const refused = prepareWorktree(fleetGit(), req(), worktreePath, frozen, (p) =>
      p.replaceAll('\\', '/') === legacy.replaceAll('\\', '/'),
    );
    await expect(refused).rejects.toThrow('live run');
    await expect(fsp.stat(legacy)).resolves.toBeDefined();
  });

  it('refuses when the conflicting registration is dirty — nothing is destroyed', async () => {
    const legacy = await legacyConflict();
    await fsp.writeFile(path.join(legacy, 'uncommitted.txt'), 'half-finished\n');

    await expect(prepareWorktree(fleetGit(), req(), worktreePath, frozen)).rejects.toThrow(
      'dirty worktree',
    );
    await expect(fsp.readFile(path.join(legacy, 'uncommitted.txt'), 'utf8')).resolves.toBe(
      'half-finished\n',
    );
  });

  it('recreates a stale clean worktree (registration lost, tree still runnable)', async () => {
    await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    // The verified leftover: the admin gitdir file is gone — the entry
    // vanishes from the list while the directory still answers to git.
    await fsp.rm(path.join(repo, '.git', 'worktrees', adminName, 'gitdir'));

    const result = await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    expect(result).toEqual({ outcome: 'recreated', sessionInvalidated: true, movedTo: null });
    expect(await listing()).toContain(`branch refs/heads/${BRANCH}`);
    expect(await headOf(worktreePath)).toBe(BRANCH);
  });

  it('moves a stale dirty worktree aside, keeps it, and checks out fresh', async () => {
    await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    await fsp.writeFile(path.join(worktreePath, 'uncommitted.txt'), 'half-finished\n');
    await fsp.rm(path.join(repo, '.git', 'worktrees', adminName, 'gitdir'));

    const result = await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    expect(result.outcome).toBe('moved-aside');
    expect(result.sessionInvalidated).toBe(true);
    expect(result.movedTo).toBe(`${worktreePath}.stale-20261019T010203`);
    await expect(fsp.readFile(path.join(result.movedTo!, 'uncommitted.txt'), 'utf8')).resolves.toBe(
      'half-finished\n',
    );
    // The original path holds a fresh, clean checkout of the branch.
    expect(await headOf(worktreePath)).toBe(BRANCH);
    expect((await git(worktreePath, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('suffixes the stamp when the frozen clock collides', async () => {
    for (const suffix of ['', '-2']) {
      await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
      await fsp.writeFile(path.join(worktreePath, 'uncommitted.txt'), `half-finished${suffix}\n`);
      await fsp.rm(path.join(repo, '.git', 'worktrees', adminName, 'gitdir'));
      const result = await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
      expect(result.outcome).toBe('moved-aside');
      expect(result.movedTo).toBe(`${worktreePath}.stale-20261019T010203${suffix}`);
    }
  });

  it('moves a stale uninspectable directory aside instead of deleting it', async () => {
    await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    await fsp.writeFile(path.join(worktreePath, 'notes.txt'), 'keep me\n');
    // The verified leftover: `<wt>/.git` is gone — the tree cannot
    // answer to git, so cleanliness cannot be proven.
    await fsp.rm(path.join(worktreePath, '.git'));

    const result = await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    expect(result.outcome).toBe('moved-aside');
    expect(result.sessionInvalidated).toBe(true);
    await expect(fsp.readFile(path.join(result.movedTo!, 'notes.txt'), 'utf8')).resolves.toBe('keep me\n');
    expect(await headOf(worktreePath)).toBe(BRANCH);
  });

  it('refuses a registered worktree on the wrong branch and modifies nothing', async () => {
    await git(repo, ['branch', 'other']);
    const foreign = path.join(baseDir, 'wt-other');
    await git(repo, ['worktree', 'add', foreign, 'other']);
    await fsp.writeFile(path.join(foreign, 'uncommitted.txt'), 'keep\n');

    const before = await listing();
    await expect(prepareWorktree(fleetGit(), req(), foreign, frozen)).rejects.toThrow(
      'is on refs/heads/other, expected t/T-0091 — refusing to touch it',
    );
    expect(await listing()).toBe(before);
    await expect(fsp.readFile(path.join(foreign, 'uncommitted.txt'), 'utf8')).resolves.toBe('keep\n');
  });

  it('refuses a locked worktree and modifies nothing', async () => {
    await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    await fsp.writeFile(path.join(worktreePath, 'uncommitted.txt'), 'dirty\n');
    await git(repo, ['worktree', 'lock', worktreePath]);

    const before = await listing();
    await expect(prepareWorktree(fleetGit(), req(), worktreePath, frozen)).rejects.toThrow('is locked');
    expect(await listing()).toBe(before);
    expect(await siblings()).toEqual([adminName]);
    await expect(fsp.readFile(path.join(worktreePath, 'uncommitted.txt'), 'utf8')).resolves.toBe('dirty\n');
  });

  /** Diverge repo main and the worktree's branch so a merge or rebase
   *  conflicts and stops mid-operation. */
  const diverge = async (): Promise<void> => {
    await fsp.writeFile(path.join(repo, 'file.txt'), 'three\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'main change']);
    await fsp.writeFile(path.join(worktreePath, 'file.txt'), 'two\n');
    await git(worktreePath, ['add', '.']);
    await git(worktreePath, ['commit', '-m', 'worktree change']);
  };

  it('refuses a worktree with a merge in progress and modifies nothing', async () => {
    await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    await diverge();
    await expect(git(worktreePath, ['merge', 'main'])).rejects.toBeDefined();

    const before = await listing();
    await expect(prepareWorktree(fleetGit(), req(), worktreePath, frozen)).rejects.toThrow(
      'has a merge in progress',
    );
    expect(await listing()).toBe(before);
    expect(await siblings()).toEqual([adminName]);
  });

  it('refuses a worktree with a rebase in progress (detached) and modifies nothing', async () => {
    await prepareWorktree(fleetGit(), req(), worktreePath, frozen);
    await diverge();
    await expect(git(worktreePath, ['rebase', 'main'])).rejects.toBeDefined();

    const before = await listing();
    // A rebase detaches HEAD, so the branch guard fires first.
    await expect(prepareWorktree(fleetGit(), req(), worktreePath, frozen)).rejects.toThrow(
      'is on a detached HEAD, expected t/T-0091 — refusing to touch it',
    );
    expect(await listing()).toBe(before);
    expect(await siblings()).toEqual([adminName]);
    // The rebase is still in progress — nothing was touched.
    const marker = (await git(worktreePath, ['rev-parse', '--git-path', 'rebase-merge'])).trim();
    await expect(fsp.stat(marker)).resolves.toBeDefined();
  });

  it('serializes two concurrent prepares on one path (exactly one add)', async () => {
    // Two independent seams: the module-level lock, not the git queue,
    // must serialize them.
    const [first, second] = await Promise.all([
      prepareWorktree(fleetGit(), req(), worktreePath, frozen),
      prepareWorktree(fleetGit(), req(), worktreePath, frozen),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(['created', 'reused']);
    const mine = parseWorktreePorcelain(await listing()).filter((e) => e.path.endsWith(adminName));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.branch).toBe(`refs/heads/${BRANCH}`);
  });
});

// -------------------------------------------------------------------------

describe('RunSupervisor worktree wiring', () => {
  let vaultDir = '';
  let fleetRoot = '';

  beforeEach(async () => {
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-vault-'));
    fleetRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-fleet-'));
  });

  afterEach(async () => {
    await fsp.rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await fsp.rm(fleetRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function fakeAdapter() {
    const handles: Array<
      WorkerHandle & { fail: (code: number | null) => void; onEvent: (text: string) => void; result: () => void }
    > = [];
    const adapter: ProviderAdapter = {
      id: 'opencode',
      label: 'OpenCode',
      liveInject: true,
      spawn: (start) => {
        let exitResolve: ((code: number | null) => void) | null = null;
        const handle: WorkerHandle & {
          fail: (code: number | null) => void;
          onEvent: (text: string) => void;
          result: () => void;
        } = {
          pid: 4242,
          exited: new Promise<number | null>((resolve) => {
            exitResolve = resolve;
          }),
          steer: vi.fn(async () => 'inject' as const),
          stop: vi.fn(async () => {
            exitResolve?.(null);
          }),
          fail: (code) => exitResolve?.(code),
          onEvent: (text) => start.onEvent({ ts: '2026-10-17T12:00:00Z', kind: 'note', text }),
          result: () => start.onEvent({ ts: '2026-10-17T12:00:00Z', kind: 'result', text: 'done' }),
        };
        handles.push(handle);
        return handle;
      },
    };
    return { adapter, handles };
  }

  function gitRecorder() {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const exec: GitExecFn = async (_exe, args, cwd) => {
      calls.push({ args, cwd });
      if (args[0] === 'rev-parse') {
        return `${path.sep}root${path.sep}tk\n`;
      }
      return '';
    };
    const ticketsGit = new TicketsGit(() => 'git', exec);
    return { ticketsGit, calls };
  }

  async function writeTicket(): Promise<string> {
    const rel = 'tickets/plan/T-0001.md';
    await fsp.mkdir(path.dirname(path.join(vaultDir, rel)), { recursive: true });
    await fsp.writeFile(
      path.join(vaultDir, rel),
      newTicketFileText({
        id: 'T-0001',
        title: 'Add the thing',
        repo: 'kt',
        priority: 'normal',
        rank: 5000,
        firstPhase: 'plan',
        now: new Date('2026-10-17T10:00:00Z'),
        actor: 'owner@box',
        description: 'It should work.',
      }),
      'utf8',
    );
    return rel;
  }

  function request(overrides: Partial<RunRequest> = {}): RunRequest {
    return {
      ticketId: 'T-0001',
      ticketsVaultPath: vaultDir,
      ticketRelPath: 'tickets/plan/T-0001.md',
      phase: 'plan',
      repoPath: 'W:/kt',
      worktreePath: path.join(fleetRoot, 'worktrees', 'kt-T-0001'),
      branch: 't/T-0001',
      baseRef: null,
      provider: 'opencode',
      model: null,
      permissionMode: 'accept-edits',
      instruction: 'Do the ticket.',
      acceptance: ['npm run verify:unit'],
      git: 'git',
      nextPhase: 'build',
      nextPhaseDir: 'build',
      pushRemote: null,
      claimIdentity: null,
      gate: 'commands',
      ...overrides,
    };
  }

  function supervisor(overrides: Partial<RunSupervisorDeps> = {}): {
    sup: RunSupervisor;
    adapter: ReturnType<typeof fakeAdapter>;
  } {
    const adapter = fakeAdapter();
    const sup = new RunSupervisor({
      root: fleetRoot,
      adapter: adapter.adapter,
      git: 'git',
      log: () => undefined,
      now: () => new Date('2026-10-17T12:00:00Z'),
      execShell: async () => undefined,
      ticketsGit: gitRecorder().ticketsGit,
      ...overrides,
    });
    return { sup, adapter };
  }

  const streamOf = async (sup: RunSupervisor, id: string): Promise<string> =>
    await fsp.readFile(sup.streamPath(id)!, 'utf8');

  it('threads a stateful outcome into the second run and its stream', async () => {
    const outcomes = ['created', 'reused'] as const;
    let calls = 0;
    const { sup, adapter } = supervisor({
      prepareWorktree: async () => ({
        outcome: outcomes[Math.min(calls++, 1)]!,
        sessionInvalidated: false,
        movedTo: null,
      }),
    });
    const rel = await writeTicket();
    const first = await sup.start(request({ ticketRelPath: rel }));
    expect(first.ok).toBe(true);
    expect((first as { run: RunInfo }).run.worktree).toBe('created');
    adapter.handles[0]!.result();
    adapter.handles[0]!.fail(0);
    const firstId = (first as { run: RunInfo }).run.id;
    await vi.waitFor(() => expect(sup.get(firstId)?.state).toBe('done'));

    // Next phase, same ticket: the worktree already exists.
    const second = await sup.start(
      request({ ticketRelPath: 'tickets/build/T-0001.md', phase: 'build', nextPhase: null }),
    );
    expect(second.ok).toBe(true);
    const info = (second as { run: RunInfo }).run;
    expect(info.worktree).toBe('reused');
    expect(await streamOf(sup, info.id)).toContain('— worktree reused');
  });

  it('reports a moved-aside worktree in the stream with its parking path', async () => {
    const { sup } = supervisor({
      prepareWorktree: async () => ({
        outcome: 'moved-aside' as const,
        sessionInvalidated: true,
        movedTo: 'W:/fleet/worktrees/kt-T-0001.stale-20261019T010203',
      }),
    });
    await writeTicket();
    const started = await sup.start(request());
    expect(started.ok).toBe(true);
    const info = (started as { run: RunInfo }).run;
    expect(info.worktree).toBe('moved-aside');
    const stream = await streamOf(sup, info.id);
    expect(stream).toContain('— worktree moved-aside');
    expect(stream).toContain(
      'stale dirty worktree moved aside to W:/fleet/worktrees/kt-T-0001.stale-20261019T010203 — kept, not deleted; earlier session context is invalid',
    );
  });

  it('wraps a rejecting preparation as a failed start, mutating nothing', async () => {
    const { sup, adapter } = supervisor({
      prepareWorktree: async () => {
        throw new Error('worktree W:/x is locked');
      },
    });
    await writeTicket();
    const started = await sup.start(request());
    expect(started.ok).toBe(false);
    expect((started as { error: string }).error).toContain('worktree failed:');
    expect((started as { error: string }).error).toContain('is locked');
    expect(sup.list()).toHaveLength(0);
    expect(adapter.handles).toHaveLength(0);
  });
});
