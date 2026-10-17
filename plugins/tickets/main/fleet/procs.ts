/**
 * Process plumbing for the fleet runner (ADR-0075): detached spawns the
 * runner owns, kill-tree with the started-at guard (a PID may have been
 * reused since the run was recorded — the guard keeps the tree-kill from
 * hitting an innocent process), and a free loopback port.
 *
 * Everything here takes its exec through a seam so the specs can run the
 * logic without touching real processes.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import * as net from 'node:net';

const isWindows = process.platform === 'win32';

/** The one bit of `ChildProcess` the runner needs, shaped for tests. */
export interface RunnerProcess {
  readonly pid: number;
  /** Writes to the worker's stdin (the steer ladder's injection rung). */
  write(text: string): void;
  /** Closes stdin — a stream-json worker sees the conversation end. */
  endInput(): void;
  onStdout(cb: (chunk: string) => void): void;
  onStderr(cb: (chunk: string) => void): void;
  /** Resolves once the process is gone (exit or signal). */
  onExit(cb: (code: number | null) => void): void;
  /** Kill-tree, unguarded: the runner spawned this child itself. */
  killTree(): Promise<void>;
}

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
) => RunnerProcess;

export function nodeSpawnFn(): SpawnFn {
  return (cmd, args, opts) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env === undefined ? undefined : { ...process.env, ...opts.env },
      // Own process group on POSIX so the tree-kill reaches grandchildren;
      // on Windows the tree kill is taskkill /T anyway.
      detached: !isWindows,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const proc: RunnerProcess = {
      pid: child.pid ?? -1,
      write: (text) => {
        child.stdin?.write(text);
      },
      endInput: () => {
        child.stdin?.end();
      },
      onStdout: (cb) => {
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', cb);
      },
      onStderr: (cb) => {
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', cb);
      },
      onExit: (cb) => {
        child.once('exit', (code) => cb(code));
        child.once('error', () => cb(-1));
      },
      killTree: async () => {
        await rawKillTree(child.pid ?? -1);
      },
    };
    return proc;
  };
}

function spawn(
  cmd: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    detached: boolean;
    windowsHide: boolean;
    stdio?: ('pipe' | 'ignore' | 'inherit')[],
  },
): import('node:child_process').ChildProcess {
  return nodeSpawn(cmd, args, opts);
}

/**
 * The stop primitive: tree-kill by PID. `startedAtMs` turns this into
 * the guarded form — before killing, the live process' creation time
 * must match the recorded one (±5s skew), else the PID was reused and
 * the kill is refused.
 */
export async function killTreeGuarded(
  pid: number,
  exec: (cmd: string, args: readonly string[]) => Promise<string>,
  startedAtMs?: number,
): Promise<'killed' | 'already-gone' | 'refused-pid-reuse'> {
  if (startedAtMs !== undefined) {
    const live = await processStartMs(pid, exec);
    if (live === null) {
      return 'already-gone';
    }
    if (Math.abs(live - startedAtMs) > 5_000) {
      return 'refused-pid-reuse';
    }
  }
  await rawKillTree(pid);
  return 'killed';
}

async function rawKillTree(pid: number): Promise<void> {
  if (isWindows) {
    await execWait('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  try {
    // detached => the child leads its own process group; -pid hits it all.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone — a stop is allowed to be idempotent
    }
  }
}

async function execWait(cmd: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = nodeSpawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
}

/** Exec seam the guard uses (test fake over this). */
export type ExecFn = (cmd: string, args: readonly string[]) => Promise<string>;

/** The process' creation time in epoch ms, or null when it is gone. */
export async function processStartMs(pid: number, exec: ExecFn): Promise<number | null> {
  try {
    if (isWindows) {
      const out = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds`,
        ],
      );
      const ms = Number(out.trim());
      return Number.isFinite(ms) ? ms : null;
    }
    const out = await exec('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const parsed = Date.parse(out.trim());
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

/** A free loopback port (bind, read, close — racy but standard). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
