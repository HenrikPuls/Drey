/**
 * The tickets repo's git access (ADR-0076: a transition is one commit).
 *
 * A deliberately minimal sibling of the git plugin's runner (plugins
 * cannot import each other): `execFile` on the installed git, no
 * shell, no timeout (ADR-0014 stance), one promise-chain queue per
 * working directory so a transition's `add` + `commit` never
 * interleaves with the next. The queue key is the vault path — there
 * is exactly one tickets repo, but locate() may probe other folders on
 * the way to finding it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;

export type GitExecutable = () => string;

export interface RepoLocation {
  /** Absolute repo root (`git rev-parse --show-toplevel`). */
  readonly root: string;
  /** The vault's path inside the repo, trailing slash, `''` at root. */
  readonly prefix: string;
}

/** A test seam: (exe, args, cwd) -> stdout. */
export type GitExecFn = (
  exe: string,
  args: readonly string[],
  cwd: string,
) => Promise<string>;

async function defaultExec(exe: string, args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(exe, ['-c', 'core.quotepath=false', '--literal-pathspecs', ...args], {
    cwd,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return stdout;
}

export class TicketsGit {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly executable: GitExecutable,
    private readonly exec: GitExecFn = defaultExec,
  ) {}

  /** Serialized per working directory; self-cleans the tail. The stored
   *  tail is the SETTLED promise (never rejects), so a failing run never
   *  leaves an unhandled rejection behind and never blocks the next. */
  run(cwd: string, args: readonly string[]): Promise<string> {
    const prev = this.queues.get(cwd) ?? Promise.resolve();
    const result = prev.then(() => this.exec(this.executable(), args, cwd));
    const settled = result.catch(() => undefined);
    this.queues.set(cwd, settled);
    void settled.then(() => {
      if (this.queues.get(cwd) === settled) {
        this.queues.delete(cwd);
      }
    });
    return result;
  }

  /**
   * Where the vault at `vaultPath` sits in git: `{root, prefix}`, or
   * null when it is not inside a git repository (the board shows the
   * unversioned warning; transitions still work, minus the commit).
   */
  async locate(vaultPath: string): Promise<RepoLocation | null> {
    try {
      const out = await this.run(vaultPath, ['rev-parse', '--show-toplevel', '--show-prefix']);
      const [root, prefix] = out.trim().split('\n');
      if (root === undefined || root === '') {
        return null;
      }
      return { root, prefix: prefix ?? '' };
    } catch {
      return null;
    }
  }

  /**
   * Stages exactly `repoRelPaths` and commits exactly them
   * (`git commit -- paths` leaves anything else staged untouched), as
   * one transition commit. A "nothing to commit" outcome resolves
   * quietly — the move is still correct on disk.
   */
  async commitPaths(
    root: string,
    repoRelPaths: readonly string[],
    message: string,
  ): Promise<void> {
    const unique = [...new Set(repoRelPaths)];
    await this.run(root, ['add', '--', ...unique]);
    try {
      await this.run(root, ['commit', '-m', message, '--', ...unique]);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!/nothing to commit|nothing added to commit/i.test(text)) {
        throw error;
      }
    }
  }
}
