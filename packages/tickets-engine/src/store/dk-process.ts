import { execFile } from 'node:child_process';
import path from 'node:path';

import { TicketStoreError, type TicketStoreErrorKind } from '../ports/ticket-store';

/**
 * The `dk` process wrapper (E14-1): spawns the installed dricket program
 * with `--json` and turns its envelope and exit codes into typed results.
 * It decides nothing about tickets — claims, leases, epochs and stages are
 * dricket's; this file only moves bytes, queues calls per repository and
 * names failures.
 *
 * No shell (`execFile`), no wall-clock timeout on writes (the user cancels
 * through the abort signal; dricket has its own 30 s budget), a timeout on
 * reads, a serial queue per store for writes and a small read concurrency.
 */

/**
 * The oldest dk this engine speaks to: v0.6.0 has `put --claim --if-version`
 * (E14-4's write path). v0.6.1 is recommended — it fixes the parallel-read
 * failure and starts far fewer git processes (R-26, R-30).
 */
export const MIN_DK_VERSION = '0.6.0';
export const RECOMMENDED_DK_VERSION = '0.6.1';

/** The envelope schema version the decoder understands. */
export const DK_SCHEMA_VERSION = 1;

/** dk's documented exit codes (observed on v0.5.0) -> the port's error kinds. */
export const DK_EXIT_KINDS: Readonly<Record<number, TicketStoreErrorKind>> = {
  1: 'error',
  2: 'usage',
  10: 'not-found',
  11: 'claimed',
  12: 'conflict',
  13: 'claim-lost',
  14: 'invalid',
  15: 'network',
  16: 'too-old',
  17: 'forbidden',
  18: 'quota',
  19: 'secret',
};

/** dk's `error.kind` strings -> the port's kinds (`outcome-unknown` shares exit 15 with `network`). */
const DK_KIND_NAMES: Readonly<Record<string, TicketStoreErrorKind>> = {
  'not-found': 'not-found',
  claimed: 'claimed',
  conflict: 'conflict',
  'claim-lost': 'claim-lost',
  invalid: 'invalid',
  network: 'network',
  'outcome-unknown': 'network',
  'too-old': 'too-old',
  forbidden: 'forbidden',
  quota: 'quota',
  secret: 'secret',
  usage: 'usage',
  error: 'error',
  unexpected: 'error',
};

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Exit code; null when the process did not run to an exit. */
  readonly code: number | null;
  /** Spawn failure (`ENOENT`, ...) or `ABORT_ERR` / `ETIMEDOUT`. */
  readonly failure: string | null;
}

export interface ExecOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number | null;
  readonly signal: AbortSignal | undefined;
  /** Working directory; undefined = the engine's own (`dk sync` runs inside a checkout). */
  readonly cwd?: string | undefined;
}

/** Injectable for unit tests; the default spawns for real. */
export type ExecFn = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export const defaultExec: ExecFn = (file, args, options) =>
  new Promise<ExecResult>((resolve) => {
    execFile(
      file,
      [...args],
      {
        env: options.env,
        windowsHide: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        ...(options.timeoutMs === null ? {} : { timeout: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr, code: 0, failure: null });
          return;
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (typeof e.code === 'number') {
          resolve({ stdout, stderr, code: e.code, failure: null });
          return;
        }
        const failure = e.name === 'AbortError' || e.code === 'ABORT_ERR' ? 'ABORT_ERR' : e.killed === true ? 'ETIMEDOUT' : String(e.code ?? e.message);
        resolve({ stdout, stderr, code: null, failure });
      },
    );
  });

// ---------------------------------------------------------------------------
// Versions

/** `v0.5.0` / `0.5.0` / `version: v0.5.0` -> [0,5,0]; null for `dev` and anything else. */
export function parseDkVersion(text: string): readonly [number, number, number] | null {
  const m = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return 0;
}

/** Throws `too-old` for a release older than {@link MIN_DK_VERSION}; a `dev` build passes (dk itself skips its own check for it). */
export function assertDkVersion(versionText: string, bin: string): void {
  const parsed = parseDkVersion(versionText);
  if (parsed === null) {
    if (/\bdev\b/.test(versionText)) {
      return;
    }
    throw new TicketStoreError('unavailable', `${bin}: could not read a version from "${versionText.trim().slice(0, 80)}"`);
  }
  if (compareVersions(parsed, parseDkVersion(MIN_DK_VERSION)!) < 0) {
    throw new TicketStoreError(
      'too-old',
      `dk ${parsed.join('.')} at ${bin} is too old: Drey needs dk ${MIN_DK_VERSION} or newer. Install a newer dricket release or set tickets.dk.path.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Queue

class RepoQueue {
  private writeTail: Promise<unknown> = Promise.resolve();
  private activeReads = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly readLimit: number) {}

  write<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeTail.catch(() => undefined).then(op);
    this.writeTail = next;
    return next;
  }

  async read<T>(op: () => Promise<T>): Promise<T> {
    if (this.activeReads >= this.readLimit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.activeReads += 1;
    try {
      return await op();
    } finally {
      this.activeReads -= 1;
      this.waiting.shift()?.();
    }
  }
}

/** One queue per repository, shared by every wrapper instance in this process. */
const QUEUES = new Map<string, RepoQueue>();

function queueFor(key: string, readLimit: number): RepoQueue {
  let queue = QUEUES.get(key);
  if (queue === undefined) {
    queue = new RepoQueue(readLimit);
    QUEUES.set(key, queue);
  }
  return queue;
}

// ---------------------------------------------------------------------------
// The wrapper

export interface DkProcessOptions {
  /** Path of the `dk` executable (or `dk` to resolve on PATH). */
  readonly bin: string;
  /** The ticket store: a directory, or `<remote>#<branch>` (`DK_STORE`). */
  readonly store: string;
  /** Where dk keeps its private working copies (`DK_DATA_DIR`); null = dk's default. */
  readonly dataDir?: string | null;
  /** Extra environment (tests set HOME / USERPROFILE here); defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly exec?: ExecFn;
  /** Reads time out; writes never do. Default 30 s. */
  readonly readTimeoutMs?: number;
  /** Parallel reads per repository. Default 4. */
  readonly readConcurrency?: number;
}

export interface DkCallOptions {
  /** The actor (`DK_OWNER`); omitted = dk's own profile identity. */
  readonly actor?: string;
  readonly write: boolean;
  readonly signal?: AbortSignal;
  /** Run inside this directory (`dk sync` needs a ticket checkout). */
  readonly cwd?: string;
}

export class DkProcess {
  private readonly exec: ExecFn;
  private readonly queue: RepoQueue;
  private versionText: string | null = null;
  private versionChecked = false;

  constructor(private readonly options: DkProcessOptions) {
    this.exec = options.exec ?? defaultExec;
    this.queue = queueFor(queueKey(options.store), options.readConcurrency ?? 4);
  }

  get bin(): string {
    return this.options.bin;
  }

  /** The reported version line, e.g. `v0.5.0`; gate included. */
  async version(): Promise<string> {
    await this.ensureVersion();
    return this.versionText ?? 'dev';
  }

  /**
   * Run `dk --json <args>` and return the envelope's `data`. Failures are
   * {@link TicketStoreError}s: the envelope's kind when dk sent one, else
   * the exit-code table.
   */
  async call(args: readonly string[], call: DkCallOptions): Promise<unknown> {
    await this.ensureVersion();
    const run = (): Promise<unknown> => this.run(['--json', ...args], call);
    return call.write ? this.queue.write(run) : this.queue.read(run);
  }

  private async ensureVersion(): Promise<void> {
    if (this.versionChecked) {
      return;
    }
    const result = await this.exec(this.options.bin, ['--version'], {
      env: this.env(undefined),
      timeoutMs: this.options.readTimeoutMs ?? 30_000,
      signal: undefined,
    });
    if (result.failure !== null || result.code !== 0) {
      throw this.spawnError(result);
    }
    const line = /version:\s*(\S+)/.exec(result.stdout)?.[1] ?? result.stdout.trim().split(/\r?\n/)[0] ?? '';
    assertDkVersion(line, this.options.bin);
    this.versionText = line;
    this.versionChecked = true;
  }

  private env(actor: string | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), NO_COLOR: '1', DK_STORE: this.options.store };
    if (this.options.dataDir !== undefined && this.options.dataDir !== null) {
      env['DK_DATA_DIR'] = this.options.dataDir;
    }
    if (actor !== undefined) {
      env['DK_OWNER'] = actor;
    }
    return env;
  }

  private spawnError(result: ExecResult): TicketStoreError {
    if (result.failure === 'ABORT_ERR') {
      return new TicketStoreError('cancelled', 'cancelled');
    }
    if (result.failure === 'ETIMEDOUT') {
      return new TicketStoreError('unavailable', `${this.options.bin} did not answer in time`);
    }
    if (result.failure === 'ENOENT') {
      return new TicketStoreError('unavailable', `dk was not found at "${this.options.bin}" — install dricket or set tickets.dk.path`);
    }
    if (result.failure !== null) {
      return new TicketStoreError('unavailable', `${this.options.bin} could not run: ${result.failure}`);
    }
    return new TicketStoreError('unavailable', `${this.options.bin} --version exited ${result.code ?? '?'}: ${firstLine(result.stderr || result.stdout)}`);
  }

  private async run(args: readonly string[], call: DkCallOptions): Promise<unknown> {
    const result = await this.exec(this.options.bin, args, {
      env: this.env(call.actor),
      timeoutMs: call.write ? null : (this.options.readTimeoutMs ?? 30_000),
      signal: call.signal,
      cwd: call.cwd,
    });
    if (result.failure !== null) {
      throw this.spawnError(result);
    }
    return decodeEnvelope(result);
  }
}

function queueKey(store: string): string {
  const normalised = path.isAbsolute(store) ? path.resolve(store) : store;
  return process.platform === 'win32' ? normalised.toLowerCase() : normalised;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? '';
}

/** Decode one finished `dk --json` run: the data on success, a typed error otherwise. */
export function decodeEnvelope(result: ExecResult): unknown {
  let envelope: unknown = null;
  const out = result.stdout.trim();
  if (out !== '') {
    try {
      envelope = JSON.parse(out);
    } catch {
      envelope = null;
    }
  }
  const record = envelope !== null && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : null;

  if (record !== null && typeof record['schema_version'] === 'number' && record['schema_version'] !== DK_SCHEMA_VERSION) {
    throw new TicketStoreError('unavailable', `dk answered with schema_version ${record['schema_version']}; this engine understands ${DK_SCHEMA_VERSION}`);
  }

  if (result.code !== 0) {
    const error = record?.['error'];
    if (error !== undefined && error !== null && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      const named = typeof e['kind'] === 'string' ? DK_KIND_NAMES[e['kind']] : undefined;
      const kind = named ?? DK_EXIT_KINDS[result.code ?? -1] ?? 'error';
      const message = typeof e['message'] === 'string' ? e['message'] : firstLine(result.stderr) || `dk exited ${result.code}`;
      throw new TicketStoreError(kind, message, result.code);
    }
    throw new TicketStoreError(DK_EXIT_KINDS[result.code ?? -1] ?? 'error', firstLine(result.stderr) || `dk exited ${result.code}`, result.code);
  }

  if (record === null || !('data' in record)) {
    throw new TicketStoreError('unavailable', `dk --json answered something this engine does not understand: ${out.slice(0, 120)}`);
  }
  return record['data'];
}
