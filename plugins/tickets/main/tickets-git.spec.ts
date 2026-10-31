import { describe, expect, it } from 'vitest';
import { TicketsGit, type GitExecFn } from './tickets-git';

/** Records calls; answers with a scripted (sync or async) result. */
function recorder(
  script: (args: readonly string[]) => string | Error | Promise<string> = () => '',
): {
  calls: { args: readonly string[]; cwd: string }[];
  exec: GitExecFn;
} {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const exec: GitExecFn = async (exe, args, cwd) => {
    calls.push({ args, cwd });
    if (exe !== 'git') {
      throw new Error('git not found');
    }
    const answer = await script(args);
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  };
  return { calls, exec };
}

describe('TicketsGit', () => {
  it('locates the repo root and prefix from a vault path', async () => {
    const { calls, exec } = recorder((args) =>
      args[0] === 'rev-parse' ? 'E:/repo\nsrc/tickets/\n' : '',
    );
    const git = new TicketsGit(() => 'git', exec);
    const located = await git.locate('E:/repo/src/tickets');
    expect(located).toEqual({ root: 'E:/repo', prefix: 'src/tickets/' });
    expect(calls[0]!.args).toContain('--show-toplevel');
  });

  it('locate is null outside a repository', async () => {
    const { exec } = recorder(() => new Error('fatal: not a git repository'));
    const git = new TicketsGit(() => 'git', exec);
    expect(await git.locate('E:/nowhere')).toBeNull();
  });

  it('commits exactly the given paths: add, then commit -- paths', async () => {
    const { calls, exec } = recorder();
    const git = new TicketsGit(() => 'git', exec);
    await git.commitPaths('E:/repo', ['a.md', 'b.md', 'a.md'], 'tickets: T-1 x -> y');
    const add = calls.find((c) => c.args.includes('add'))!;
    const commit = calls.find((c) => c.args.includes('commit'))!;
    expect(add.args).toEqual(['add', '--', 'a.md', 'b.md']);
    expect(commit.args.slice(0, 3)).toEqual(['commit', '-m', 'tickets: T-1 x -> y']);
    expect(commit.args.slice(-3)).toEqual(['--', 'a.md', 'b.md']);
    for (const call of calls) {
      expect(call.cwd).toBe('E:/repo');
    }
  });

  it('tolerates a nothing-to-commit outcome', async () => {
    let commitCount = 0;
    const { exec } = recorder((args) => {
      if (args.includes('commit')) {
        commitCount++;
        return new Error('nothing to commit, working tree clean');
      }
      return '';
    });
    const git = new TicketsGit(() => 'git', exec);
    await expect(git.commitPaths('E:/repo', ['a.md'], 'msg')).resolves.toBeUndefined();
    expect(commitCount).toBe(1);
  });

  it('tolerates git\'s "no changes added to commit" outcome too', async () => {
    const { exec } = recorder((args) =>
      args.includes('commit') ? new Error('Command failed: git commit\nno changes added to commit') : '',
    );
    const git = new TicketsGit(() => 'git', exec);
    await expect(git.commitPaths('E:/repo', ['a.md'], 'msg')).resolves.toBeUndefined();
  });

  it('drops a path another commit already removed and commits the rest', async () => {
    const { calls, exec } = recorder((args) =>
      args.includes('add') && args.includes('old/T-1.md')
        ? new Error("Command failed: git add\nfatal: pathspec 'old/T-1.md' did not match any files")
        : '',
    );
    const git = new TicketsGit(() => 'git', exec);
    await git.commitPaths('E:/repo', ['old/T-1.md', 'new/T-1.md'], 'tickets: T-1 old -> new');
    expect(calls.map((c) => c.args[0])).toEqual(['add', 'add', 'commit']);
    expect(calls[1]!.args).toEqual(['add', '--', 'new/T-1.md']);
    expect(calls[2]!.args.slice(-2)).toEqual(['--', 'new/T-1.md']);
  });

  it('resolves quietly when every path is already gone, and rethrows other add failures', async () => {
    const gone = recorder((args) =>
      args.includes('add') ? new Error("fatal: pathspec 'a.md' did not match any files") : '',
    );
    await expect(new TicketsGit(() => 'git', gone.exec).commitPaths('E:/repo', ['a.md'], 'msg')).resolves.toBeUndefined();
    expect(gone.calls.some((c) => c.args.includes('commit'))).toBe(false);
    const locked = recorder((args) => (args.includes('add') ? new Error('fatal: Unable to create index.lock') : ''));
    await expect(new TicketsGit(() => 'git', locked.exec).commitPaths('E:/repo', ['a.md'], 'msg')).rejects.toThrow('index.lock');
  });

  it('pushes HEAD to the named remote from the repo root (T-0041)', async () => {
    const { calls, exec } = recorder();
    const git = new TicketsGit(() => 'git', exec);
    await git.push('E:/repo', 'origin');
    const push = calls.find((c) => c.args[0] === 'push')!;
    expect(push.args).toEqual(['push', 'origin', 'HEAD']);
    expect(push.cwd).toBe('E:/repo');
  });

  it('rethrows real failures and never interleaves queued runs', async () => {
    const order: string[] = [];
    let failFirst = true;
    const { exec } = recorder((args) => {
      if (args.includes('commit') && failFirst) {
        failFirst = false;
        return new Error('fatal: bad config');
      }
      return '';
    });
    const git = new TicketsGit(() => 'git', exec);
    const first = git.commitPaths('E:/repo', ['a.md'], 'one').catch((e: Error) => order.push(`err:${e.message}`));
    const second = git.commitPaths('E:/repo', ['b.md'], 'two').then(() => order.push('two'));
    await Promise.all([first, second]);
    // The failing run neither blocks nor swallows the next:
    expect(order).toEqual(['err:fatal: bad config', 'two']);
  });

  it('serializes runs on one working directory in enqueue order', async () => {
    const started: string[] = [];
    const { exec } = recorder(async (args) => {
      started.push(args[0] ?? '');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return '';
    });
    const git = new TicketsGit(() => 'git', exec);
    await Promise.all([
      git.run('E:/repo', ['status']),
      git.run('E:/repo', ['log']),
      git.run('E:/repo', ['diff']),
    ]);
    expect(started).toEqual(['status', 'log', 'diff']);
  });
});
