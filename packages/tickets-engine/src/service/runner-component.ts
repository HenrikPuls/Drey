/**
 * The Crew runner as a component of Drey Service (req-164, ADR-0092).
 *
 * The fleet runner used to be a detached process of its own, spawned by
 * the engine's fleet client and found through `fleet/runner.json`. Now it
 * runs inside the service process: {@link wake} starts it in-process
 * (`startRunner` with no descriptor file and no signal handlers of its
 * own), and when req-110's verdict lets it go — Autopilot Off with nothing
 * live, Drey gone, or its idle span — it "exits" into `sleeping` instead of
 * ending the process. Its loopback port and token stay what they were, so
 * curl, the FLEET/SERVICE routes and the engine's `FleetClient` speak to it
 * unchanged; `service.lock` records them.
 */
import type { RunnerDescriptor } from '../fleet/protocol';
import { startRunner, type Args, type RunnerDeps, type RunnerHandle } from '../fleet/runner';
import type { RunnerLocator } from '../services/fleet-client';
import type { ComponentRecord } from './service-lock';

export interface RunnerComponentOptions {
  /** The fleet root, `<home>/fleet`. */
  readonly root: string;
  /** The runner's own idle span (req-110); 15 min by default. */
  readonly idleMs?: number;
  /** Whether the board lives in a dricket store (D-42), read at every wake. */
  readonly storeBacked: () => Promise<boolean>;
  /** Every runner log line, into the service log. */
  readonly log: (line: string) => void;
  /** The component changed state — the service rewrites its lock. */
  readonly onChange: () => void;
  /** Test seam: the in-process start. */
  readonly start?: (args: Args, deps: RunnerDeps) => Promise<RunnerHandle | null>;
}

type HandoverReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

export class RunnerComponent implements RunnerLocator {
  private handle: RunnerHandle | null = null;
  private starting: Promise<{ ok: true; descriptor: RunnerDescriptor } | { ok: false; error: string }> | null = null;
  private state: 'sleeping' | 'starting' | 'running' | 'failed' = 'sleeping';
  private detail: string | null = 'wakes on demand';
  /** Why a wake is refused for now (an older runner still finishing its gate, req-164's migration). */
  private blockedBy: string | null = null;
  private generation = 0;
  private readonly exited = new Set<() => void>();

  constructor(private readonly opts: RunnerComponentOptions) {}

  current(): Promise<RunnerDescriptor | null> {
    return Promise.resolve(this.handle?.descriptor ?? null);
  }

  get awake(): boolean {
    return this.handle !== null || this.state === 'starting';
  }

  /** Blocks (a reason) or unblocks (null) the wake — the migration's wait for a busy legacy runner. */
  block(reason: string | null): void {
    this.blockedBy = reason;
    if (this.handle === null && this.state !== 'starting') {
      this.state = reason === null ? 'sleeping' : 'failed';
      this.detail = reason ?? 'wakes on demand';
      this.opts.onChange();
    }
  }

  wake(): Promise<{ ok: true; descriptor: RunnerDescriptor } | { ok: false; error: string }> {
    if (this.handle !== null) {
      return Promise.resolve({ ok: true, descriptor: this.handle.descriptor });
    }
    if (this.blockedBy !== null) {
      return Promise.resolve({ ok: false, error: this.blockedBy });
    }
    this.starting ??= this.boot().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async boot(): Promise<{ ok: true; descriptor: RunnerDescriptor } | { ok: false; error: string }> {
    this.state = 'starting';
    this.detail = null;
    this.opts.onChange();
    const generation = ++this.generation;
    try {
      const storeBacked = await this.opts.storeBacked().catch(() => false);
      const handle = await (this.opts.start ?? startRunner)(
        { root: this.opts.root, idleMs: this.opts.idleMs ?? 15 * 60_000, storeBacked },
        {
          exit: () => this.slept(generation),
          stdout: (line) => this.opts.log(line),
          descriptor: 'none',
          signals: false,
        },
      );
      if (handle === null) {
        throw new Error('the runner refused to start');
      }
      if (generation !== this.generation || this.state !== 'starting') {
        // It went to sleep while it was still starting up.
        return { ok: false, error: 'the runner went to sleep while it started' };
      }
      this.handle = handle;
      this.state = 'running';
      this.detail = `127.0.0.1:${handle.port}`;
      this.opts.onChange();
      return { ok: true, descriptor: handle.descriptor };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = 'failed';
      this.detail = message;
      this.opts.onChange();
      return { ok: false, error: message };
    }
  }

  /** The runner's `exit`: in the service it means "asleep", not "process over". */
  private slept(generation: number): void {
    if (generation !== this.generation) {
      return;
    }
    this.generation++;
    this.handle = null;
    this.state = this.blockedBy === null ? 'sleeping' : 'failed';
    this.detail = this.blockedBy ?? 'wakes on demand';
    this.opts.onChange();
    for (const listener of [...this.exited]) {
      listener();
    }
  }

  /** The owner's stop (component stop, service quit): live runs are stopped first — the runner's own graceful stop. */
  async stop(): Promise<void> {
    if (this.starting !== null) {
      await this.starting;
    }
    const handle = this.handle;
    if (handle === null) {
      return;
    }
    const gone = this.whenAsleep(15_000);
    await handle.stop();
    await gone;
  }

  /**
   * The stale-build handover (req-51, now the service's): the runner's own
   * `/shutdown {handover: true}` — workers keep running, the records say how
   * a successor takes them back. A run in its gate refuses (409): the
   * service serves on and Drey asks again later.
   */
  async handOver(): Promise<HandoverReply> {
    const handle = this.handle;
    if (handle === null) {
      return { ok: true };
    }
    const gone = this.whenAsleep(20_000);
    const res = await fetch(`http://127.0.0.1:${handle.port}/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${handle.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ handover: true }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? 'the runner is busy' };
    }
    await gone;
    return { ok: true };
  }

  private whenAsleep(timeoutMs: number): Promise<void> {
    if (this.handle === null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.exited.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.exited.add(done);
    });
  }

  record(): ComponentRecord {
    const handle = this.handle;
    return handle === null
      ? { state: this.state, detail: this.detail }
      : {
          state: this.state,
          detail: this.detail,
          port: handle.port,
          token: handle.token,
          pid: handle.descriptor.pid,
          ...(handle.descriptor.build === undefined ? {} : { build: handle.descriptor.build }),
        };
  }
}
