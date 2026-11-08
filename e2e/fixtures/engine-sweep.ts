import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The sweep for services (formerly engines) an earlier e2e run left behind (D-43).
 *
 * Every launch under a fixture-owned home (`drey-e2e-home-*` in the temp
 * dir, `fixtures/drey.ts`) starts Drey Service (req-164) the way the app does:
 * detached and unref'd, because in production it outlives Drey (one engine
 * per user, ADR-0075). In the suite only the fixture's teardown ends it, and
 * that teardown never runs when the worker dies first -- a run aborted with
 * Ctrl+C or a task stop, a test whose teardown Playwright cuts off at the
 * timeout, a worker crash. The engine and its home then stay until someone
 * notices (five of them did, 2026-11-06).
 *
 * `globalSetup` and `globalTeardown` run this: read every leftover home's
 * `service.lock` (or a pre-service `engine.lock`), end the process when it
 * is provably ours, remove the home. The decision is in `classifyLock`,
 * pure, so it has a spec; the process work around it is deliberately
 * paranoid -- a pid can be reused, so a live pid is ended only when its
 * command line names `service-main` (or the old `engine-main`) too.
 */

export const HOME_PREFIX = 'drey-e2e-home-';

export interface EngineLock {
  readonly pid?: unknown;
  readonly vaultPath?: unknown;
}

export type LockVerdict =
  | { readonly kind: 'ours'; readonly pid: number }
  | { readonly kind: 'no-lock' }
  | { readonly kind: 'foreign'; readonly reason: string };

/**
 * Whether a lock belongs to the suite: a numeric pid and a vault under a
 * `test-results` folder (the fixture seeds its vault at
 * `test-results/<test>/vault`). A lock that points anywhere else -- the
 * owner's real tickets vault, say, should a home ever be shared -- is never
 * touched, whatever folder it was found in.
 */
export function classifyLock(lock: EngineLock | null): LockVerdict {
  if (lock === null) {
    return { kind: 'no-lock' };
  }
  if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || lock.pid <= 0) {
    return { kind: 'foreign', reason: 'no usable pid' };
  }
  if (typeof lock.vaultPath !== 'string') {
    return { kind: 'foreign', reason: 'no vault path' };
  }
  const segments = lock.vaultPath.split(/[\\/]+/);
  if (!segments.includes('test-results')) {
    return { kind: 'foreign', reason: `vault outside test-results: ${lock.vaultPath}` };
  }
  return { kind: 'ours', pid: lock.pid };
}

/** Whether the command line of a live process names the service entry (or the pre-service engine entry). */
export function isEngineCommandLine(commandLine: string | null): boolean {
  return commandLine !== null && /(service|engine)-main\.(js|ts)\b/.test(commandLine);
}

/** The home's service lock, else a pre-service engine lock; both carry `pid` and `vaultPath`. */
function readLock(home: string): EngineLock | null {
  for (const name of ['service.lock', 'engine.lock']) {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, '.drey-engine', name), 'utf8')) as EngineLock;
    } catch {
      // try the next name
    }
  }
  return null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The process's command line, or null when it cannot be read (gone, foreign user). */
function commandLineOf(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      );
      return out.trim() || null;
    }
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return null;
  }
}

export interface SweepReport {
  readonly homes: number;
  readonly stopped: number[];
  readonly skipped: string[];
  readonly removed: number;
}

export interface SweepOptions {
  readonly tmpDir?: string;
  readonly log?: (line: string) => void;
}

/** Ends the suite's leftover engines and removes their homes. Never throws. */
export function sweepLeftoverEngines(options: SweepOptions = {}): SweepReport {
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const log = options.log ?? (() => undefined);
  const stopped: number[] = [];
  const skipped: string[] = [];
  let homes = 0;
  let removed = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return { homes, stopped, skipped, removed };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(HOME_PREFIX)) {
      continue;
    }
    homes++;
    const home = path.join(tmpDir, entry.name);
    const verdict = classifyLock(readLock(home));
    if (verdict.kind === 'foreign') {
      skipped.push(`${entry.name}: ${verdict.reason}`);
      continue;
    }
    if (verdict.kind === 'ours' && alive(verdict.pid)) {
      const commandLine = commandLineOf(verdict.pid);
      if (!isEngineCommandLine(commandLine)) {
        skipped.push(`${entry.name}: pid ${verdict.pid} is alive but not an engine (${commandLine ?? 'command line unreadable'})`);
        continue;
      }
      try {
        process.kill(verdict.pid);
        stopped.push(verdict.pid);
      } catch (error) {
        skipped.push(`${entry.name}: pid ${verdict.pid} could not be ended (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
    }
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      removed++;
    } catch (error) {
      skipped.push(`${entry.name}: not removed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (homes > 0) {
    log(
      `e2e engine sweep: ${homes} leftover home(s), ${stopped.length} engine(s) ended${
        stopped.length > 0 ? ` (pid ${stopped.join(', ')})` : ''
      }, ${removed} home(s) removed${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}`,
    );
    for (const line of skipped) {
      log(`  skipped ${line}`);
    }
  }
  return { homes, stopped, skipped, removed };
}
