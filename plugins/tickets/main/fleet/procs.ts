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

/**
 * What the runner inherits from the process that spawned it and must not
 * hand on (req-56): `npm run dev` puts its `npm_*` config and lifecycle
 * variables (and `INIT_CWD`) into Drey's environment — an inherited
 * `npm_config_allow_scripts` broke every worker's npm call — and the
 * runner itself runs under `ELECTRON_RUN_AS_NODE`, which would turn any
 * Electron a worker starts into plain Node. Removed once, at the runner's
 * boot, so workers, the gate's shell and git all start clean. Returns the
 * names it removed.
 */
export function scrubInheritedEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const removed = Object.keys(env).filter(
    (key) => /^npm_/i.test(key) || key.toUpperCase() === 'INIT_CWD' || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE',
  );
  for (const key of removed) {
    delete env[key];
  }
  return removed;
}

export function nodeSpawnFn(): SpawnFn {
  return (cmd, args, opts) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env === undefined ? undefined : { ...process.env, ...opts.env },
      // Own process group on POSIX so the tree-kill reaches grandchildren;
      // on Windows the tree kill is taskkill /T anyway.
      detached: !isWindows,
      // npm installs the worker CLIs as `opencode.cmd`/`claude.cmd` shims;
      // CreateProcess resolves no PATHEXT, so without the shell a plain
      // `spawn('opencode')` fails with ENOENT and the run dies unborn.
      // The shell resolves the shims; every argv we pass is shell-safe
      // (flags and simple values — payloads travel over stdin/HTTP).
      shell: isWindows,
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
    shell?: boolean;
    windowsHide: boolean;
    stdio?: ('pipe' | 'ignore' | 'inherit')[],
  },
): import('node:child_process').ChildProcess {
  return nodeSpawn(cmd, args, { ...opts, shell: opts.shell ?? false });
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

/**
 * The lease reaper's liveness probe (M85): is the pid a running process?
 * Cheap and side-effect free — the guarded kill stays reserved for real
 * stops. A dead pid is what makes a run stale; a silent-but-alive
 * worker is a local model thinking (ADR-0014: no timeouts).
 */
export async function processAlive(pid: number, exec: ExecFn): Promise<boolean> {
  try {
    if (isWindows) {
      const out = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      return out.toLowerCase().includes(`"${pid}"`);
    }
    await exec('ps', ['-p', String(pid)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pid of the process listening on a loopback port, or null. On
 * Windows a worker server runs under a `cmd` shell (the npm shim needs
 * one, see `nodeSpawnFn`); the shell can die with its runner while the
 * server lives on, so a later runner must know the server's own pid to
 * take it back or end it. POSIX keeps the process group: null there.
 */
export async function listenerPid(port: number, exec: ExecFn): Promise<number | null> {
  if (!isWindows || !Number.isInteger(port) || port <= 0) {
    return null;
  }
  try {
    const out = await exec('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess`,
    ]);
    const pid = Number(out.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
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
