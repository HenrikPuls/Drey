/**
 * Runs the installed `git` (ADR-0065). One place owns everything about the
 * process: no shell (arguments reach git as they are, so a file or branch
 * name can never be read as shell syntax), a fixed environment (no
 * terminal prompt -- a credential helper or the SSH agent answers, or the
 * command fails with git's own message), and a queue per repository so two
 * commands never race for `index.lock`.
 *
 * There is no timeout: a fetch over a slow link may take minutes, the user
 * cancels instead (the ADR-0014 stance). Cancelling kills the process
 * tree -- on Windows through `taskkill /T`, because git starts helper
 * processes (`git-remote-https`) a plain kill would orphan.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';

/** 64 MB: a `git show` of a large file must not hit the 1 MB default. */
const MAX_BUFFER = 64 * 1024 * 1024;

export type GitErrorKind = 'not-found' | 'failed' | 'cancelled';

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitRunOptions {
  /** Text for the command's stdin (`commit -F -`). */
  readonly input?: string;
  /** A read that must not take the index lock or refresh the index on disk. */
  readonly readOnly?: boolean;
  /** Aborting kills the process tree and rejects with `kind: 'cancelled'`. */
  readonly signal?: AbortSignal;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => child.kill(),
    );
  } else {
    child.kill();
  }
}

/** git prefixes its messages; the dialog shows them without the noise. */
function cleanMessage(stderr: string, stdout: string): string {
  const text = (stderr.trim() !== '' ? stderr : stdout).trim();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^(fatal|error): /, ''))
    .filter((line) => line.trim() !== '' && !line.startsWith('hint: '));
  return lines.join('\n') || 'git failed without a message.';
}

export class GitRunner {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly executable: () => string) {}

  /**
   * Runs `git <args>` in `cwd`, after every earlier command queued for the
   * same `queueKey` (the repository root) has settled. Resolves with
   * stdout; rejects with a {@link GitError}.
   */
  run(cwd: string, args: readonly string[], options: GitRunOptions = {}, queueKey = cwd): Promise<string> {
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const next = previous.then(
      () => this.exec(cwd, args, options),
      () => this.exec(cwd, args, options),
    );
    // The queue only orders commands; a failure belongs to its own caller.
    const tail = next.catch(() => undefined);
    this.queues.set(queueKey, tail);
    void tail.then(() => {
      if (this.queues.get(queueKey) === tail) {
        this.queues.delete(queueKey);
      }
    });
    return next;
  }

  private exec(cwd: string, args: readonly string[], options: GitRunOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new GitError('cancelled', 'Cancelled.'));
        return;
      }
      const exe = this.executable();
      let cancelled = false;
      const child = execFile(
        exe,
        // Paths come back as they are on disk, not octal-escaped, and go in
        // as plain paths: a file called `*.md` or `:x` is not a pattern.
        ['-c', 'core.quotepath=false', '--literal-pathspecs', ...args],
        {
          cwd,
          windowsHide: true,
          maxBuffer: MAX_BUFFER,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            LC_ALL: 'C',
            ...(options.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
          },
        },
        (error, stdout, stderr) => {
          options.signal?.removeEventListener('abort', onAbort);
          if (cancelled) {
            reject(new GitError('cancelled', 'Cancelled.'));
          } else if (error === null) {
            resolve(stdout);
          } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new GitError('not-found', `${exe} was not found.`));
          } else {
            reject(new GitError('failed', cleanMessage(stderr, stdout)));
          }
        },
      );
      const onAbort = (): void => {
        cancelled = true;
        killTree(child);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      }
    });
  }
}
