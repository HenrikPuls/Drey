/**
 * `service.lock` — how Drey, Mission Control's host, the devices' pairing
 * and a terminal find Drey Service (req-164, ADR-0092). One file in the
 * service home (`~/.drey-engine`), rewritten whenever a component changes
 * state; it replaces the engine's `engine.lock` and the runner's
 * `fleet/runner.json`.
 *
 * The file carries bearer tokens, so it is written owner-only (0600) and
 * atomically (temp file + rename): a reader never sees half a record.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

export const SERVICE_LOCK_FILE = 'service.lock';
export const SERVICE_LOCK_VERSION = 1;

/** The four components of ADR-0092, in display order. */
export const COMPONENT_NAMES = ['engine', 'runner', 'gateway', 'mcp'] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

/**
 * A component's state. `sleeping` is the runner's rest (it wakes on demand);
 * `external` is a component another process serves (the MCP server, still
 * Drey's until req-167).
 */
export type ComponentState = 'starting' | 'running' | 'sleeping' | 'stopped' | 'failed' | 'external';

export interface ComponentRecord {
  readonly state: ComponentState;
  /** One line for the owner: why it sleeps, why it failed, where it listens. */
  readonly detail: string | null;
  /** The loopback port when it listens on one of its own. */
  readonly port?: number;
  /** The bearer token of that port (the runner's), when it has its own. */
  readonly token?: string;
  readonly pid?: number;
  readonly build?: string;
}

export interface ServiceLock {
  readonly version: number;
  readonly pid: number;
  /** The service's build stamp (`<builtAt>#<hash>`, the req-51 format over the service entry's closure). */
  readonly build: string;
  readonly startedAt: string;
  readonly home: string;
  /** The tickets vault the engine hosts. */
  readonly vaultPath: string;
  /** The service control port (`/health`, `/status`, `/shutdown`, `/components/...`). */
  readonly port: number;
  /** The bearer token of the control port and the engine's invoke channel. */
  readonly token: string;
  /** `service.enabled` (the owner's Q3 ruling): `background` outlives Drey, `with-drey` ends with it. Absent on a lock read before the mode was known. */
  readonly mode?: 'background' | 'with-drey';
  readonly components: Readonly<Record<ComponentName, ComponentRecord>>;
}

export function serviceLockPath(home: string): string {
  return path.join(home, SERVICE_LOCK_FILE);
}

/** The lock, or null when there is none or it is unreadable / not a service lock. */
export async function readServiceLock(home: string): Promise<ServiceLock | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(serviceLockPath(home), 'utf8')) as Partial<ServiceLock>;
    return isServiceLock(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isServiceLock(value: Partial<ServiceLock> | null | undefined): value is ServiceLock {
  return (
    value !== null &&
    value !== undefined &&
    typeof value.pid === 'number' &&
    typeof value.port === 'number' &&
    typeof value.token === 'string' &&
    typeof value.vaultPath === 'string' &&
    typeof value.components === 'object' &&
    value.components !== null
  );
}

export async function writeServiceLock(home: string, lock: ServiceLock): Promise<void> {
  const file = serviceLockPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, file);
}

/** Removes the lock — only when it is still this process's (a successor may already have written its own). */
export async function removeServiceLock(home: string, pid: number): Promise<void> {
  const current = await readServiceLock(home);
  if (current === null || current.pid === pid) {
    await fsp.rm(serviceLockPath(home), { force: true });
  }
}

/** The engine's invoke endpoint out of a lock, the shape Drey's `EngineClient` takes. */
export function engineEndpointsOf(lock: ServiceLock): { readonly invokeUrl: string; readonly token: string } | null {
  const engine = lock.components.engine;
  return engine?.state === 'running' && typeof engine.port === 'number'
    ? { invokeUrl: `http://127.0.0.1:${engine.port}`, token: lock.token }
    : null;
}

/** `GET /health` on the control port: true when the service answers with this token. */
export async function serviceAlive(lock: Pick<ServiceLock, 'port' | 'token'>, timeoutMs = 1_500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
      headers: { Authorization: `Bearer ${lock.token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
