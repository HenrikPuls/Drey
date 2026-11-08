/**
 * The migration of req-164: a tickets engine (`engine.lock`) and a fleet
 * runner (`fleet/runner.json`) from before Drey Service are retired on the
 * service's first start, and their lock files removed. Nothing in the
 * owner's data changes shape: `config.json`, `fleet/runs/` and the chain
 * state stay where they are, and the service's components read them as the
 * old processes did.
 *
 * Order matters: the old engine first — its fleet client would otherwise
 * spawn an old runner again the moment the old one handed over. The old
 * engine has no shutdown route, so it is ended by pid, but only after its
 * own `/api/health` answered with its own token (proof the pid is that
 * engine). The old runner is asked for the req-51 handover: its workers
 * keep running and the service's runner component takes them back on its
 * first wake. A runner with a run in its gate refuses; the service then
 * keeps its own runner from waking until the old one has gone.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { RunnerDescriptor } from '../fleet/protocol';

export const LEGACY_ENGINE_LOCK = 'engine.lock';
export const LEGACY_RUNNER_DESCRIPTOR = path.join('fleet', 'runner.json');

interface LegacyEngineLock {
  readonly pid: number;
  readonly invokePort: number;
  readonly token: string;
}

export interface LegacyDeps {
  readonly fetch?: typeof fetch;
  /** Ends a process; `process.kill` by default (TerminateProcess on Windows). */
  readonly kill?: (pid: number) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type LegacyRunnerOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'gone'; readonly pid: number }
  | { readonly kind: 'busy'; readonly pid: number; readonly reason: string };

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function answers(url: string, token: string, f: typeof fetch): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    const res = await f(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** Ends a pre-service engine found through `engine.lock`, then removes the lock. True when one was running. */
export async function retireLegacyEngine(home: string, log: (message: string) => void, deps: LegacyDeps = {}): Promise<boolean> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const file = path.join(home, LEGACY_ENGINE_LOCK);
  const lock = await readJson<Partial<LegacyEngineLock>>(file);
  if (lock === null) {
    return false;
  }
  let retired = false;
  if (typeof lock.pid === 'number' && typeof lock.invokePort === 'number' && typeof lock.token === 'string') {
    const health = `http://127.0.0.1:${lock.invokePort}/api/health`;
    if (await answers(health, lock.token, f)) {
      log(`an engine from before Drey Service is running (pid ${lock.pid}) — retiring it`);
      try {
        (deps.kill ?? ((pid: number) => process.kill(pid)))(lock.pid);
      } catch (error) {
        log(`the old engine could not be ended: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (let i = 0; i < 50 && (await answers(health, lock.token, f)); i++) {
        await sleep(100);
      }
      retired = true;
    }
  }
  await fsp.rm(file, { force: true });
  return retired;
}

/** Asks a pre-service runner found through `fleet/runner.json` to hand its runs over and leave. */
export async function retireLegacyRunner(home: string, log: (message: string) => void, deps: LegacyDeps = {}): Promise<LegacyRunnerOutcome> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const file = path.join(home, LEGACY_RUNNER_DESCRIPTOR);
  const peer = await readJson<Partial<RunnerDescriptor>>(file);
  if (peer === null) {
    return { kind: 'none' };
  }
  if (typeof peer.port !== 'number' || typeof peer.token !== 'string') {
    await fsp.rm(file, { force: true });
    return { kind: 'none' };
  }
  const base = `http://127.0.0.1:${peer.port}`;
  if (!(await answers(`${base}/health`, peer.token, f))) {
    await fsp.rm(file, { force: true });
    return { kind: 'none' };
  }
  const pid = typeof peer.pid === 'number' ? peer.pid : 0;
  try {
    const res = await f(`${base}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${peer.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ handover: true }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { kind: 'busy', pid, reason: body.error ?? 'the runner is busy' };
    }
  } catch {
    // a runner that will not take the call: wait it out below like any other
  }
  log(`a fleet runner from before Drey Service (pid ${pid}) hands its runs over to the Crew runner component`);
  for (let i = 0; i < 200 && (await answers(`${base}/health`, peer.token, f)); i++) {
    await sleep(100);
  }
  await fsp.rm(file, { force: true });
  return { kind: 'gone', pid };
}

/** True when the fleet root holds a run a retiring runner handed over — the runner wakes at boot to take it back. */
export async function hasHandedOverRuns(fleetRoot: string): Promise<boolean> {
  const runsDir = path.join(fleetRoot, 'runs');
  const ids = await fsp.readdir(runsDir).catch(() => [] as string[]);
  for (const id of ids) {
    const stored = await readJson<{ info?: { state?: string }; handover?: unknown }>(path.join(runsDir, id, 'run.json'));
    if (stored?.handover !== undefined && (stored.info?.state === 'running' || stored.info?.state === 'starting')) {
      return true;
    }
  }
  return false;
}
