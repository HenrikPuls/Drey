/**
 * The tickets plugin's side of the fleet (ADR-0075, M84): discover or
 * spawn the standalone runner, then proxy Run/Stop/Steer/Watch to its
 * loopback HTTP surface. The runner is the sibling `fleet/runner.js` of
 * this very bundle, spawned detached under ELECTRON_RUN_AS_NODE — it
 * outlives Drey, and a restart of the app re-adopts it through the
 * descriptor file instead of spawning a second one.
 *
 * The plugin never touches worker pipes; it sees runs through
 * `GET /status` (polled onto the board while anything is live) and the
 * stream files via `GET /stream/:id` for the watch view.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type {
  RunInfo,
  RunRequest,
  RunnerDescriptor,
} from './fleet/protocol';

export interface FleetClientOpts {
  /** The fleet root — `<userRoot>/fleet` (descriptor, runs, worktrees). */
  readonly root: string;
  /** The bundled runner entry (`dist-electron/plugins/tickets/main/fleet/runner.js`). */
  readonly runnerScript: string;
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Pushed whenever the polled run list differs — the board re-renders. */
  readonly onRunsChanged: (runs: readonly RunInfo[]) => void;
}

type StartOutcome = { readonly ok: true; readonly run: RunInfo } | { readonly ok: false; readonly error: string };

export class FleetClient {
  private descriptor: RunnerDescriptor | null = null;
  private spawning: Promise<boolean> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRunsJson = '[]';

  constructor(private readonly opts: FleetClientOpts) {}

  /** All runs, newest first; `[]` when no runner is alive (never throws,
   *  never spawns — the runner comes up on `start` only). */
  async runs(): Promise<readonly RunInfo[]> {
    try {
      if (!(await this.withRunner())) {
        return [];
      }
      const data = await this.get<{ runs: RunInfo[] }>('/status');
      const json = JSON.stringify(data.runs);
      if (json !== this.lastRunsJson) {
        this.lastRunsJson = json;
        this.opts.onRunsChanged(data.runs);
      }
      this.pollWhile(data.runs);
      return data.runs;
    } catch {
      return [];
    }
  }

  async start(request: RunRequest): Promise<StartOutcome> {
    if (!(await this.ensureRunner())) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return this.post<StartOutcome>('/start', request);
  }

  async stop(runId: string, reason: string | null): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.withRunner())) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return this.post<{ ok: boolean; error?: string }>('/stop', { runId, reason });
  }

  async send(runId: string, text: string): Promise<{ ok: boolean; error?: string; rung?: string }> {
    if (!(await this.withRunner())) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return this.post<{ ok: boolean; error?: string; rung?: string }>('/send', { runId, text });
  }

  /** The run's stream so far (the watch view's text), or null. */
  async stream(runId: string): Promise<string | null> {
    try {
      if (!(await this.withRunner())) {
        return null;
      }
      const res = await fetch(`${this.base()}/stream/${encodeURIComponent(runId)}`, {
        headers: this.headers(),
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // -------------------------------------------------------------------------

  private base(): string {
    return `http://127.0.0.1:${this.descriptor?.port ?? 0}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.descriptor?.token ?? ''}` };
  }

  /** Descriptor file → health check → spawn the sibling when both fail.
   *  Spawn-capable: only `start` may bring the runner up. */
  private async ensureRunner(): Promise<boolean> {
    if (this.descriptor !== null && (await this.alive(this.descriptor))) {
      return true;
    }
    this.descriptor = await this.readDescriptor();
    if (this.descriptor !== null && (await this.alive(this.descriptor))) {
      return true;
    }
    return this.spawnRunner();
  }

  /** Read-only adoption: talk to a runner that is already alive, never spawn. */
  private async withRunner(): Promise<boolean> {
    if (this.descriptor !== null && (await this.alive(this.descriptor))) {
      return true;
    }
    this.descriptor = await this.readDescriptor();
    return this.descriptor !== null && (await this.alive(this.descriptor));
  }

  private async spawnRunner(): Promise<boolean> {
    if (this.spawning !== null) {
      return this.spawning;
    }
    this.spawning = (async (): Promise<boolean> => {
      try {
        await fsp.mkdir(this.opts.root, { recursive: true });
        const child = spawn(process.execPath, [this.opts.runnerScript, '--root', this.opts.root], {
          // ELECTRON_RUN_AS_NODE: the Electron binary runs the plain
          // Node entry; detached so the runner outlives Drey.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.once('error', (error) => this.opts.log(`fleet runner spawn failed: ${String(error)}`, 'warn'));
        child.unref();
        const deadline = Date.now() + 10_000;
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          this.descriptor = await this.readDescriptor();
          if (this.descriptor !== null && (await this.alive(this.descriptor))) {
            this.opts.log(`fleet runner adopted (pid ${this.descriptor.pid}, port ${this.descriptor.port})`);
            return true;
          }
          if (Date.now() > deadline) {
            this.opts.log('the fleet runner did not come up in time', 'warn');
            return false;
          }
        }
      } catch (error) {
        this.opts.log(`the fleet runner could not be started: ${String(error)}`, 'warn');
        return false;
      } finally {
        this.spawning = null;
      }
    })();
    return this.spawning;
  }

  private async readDescriptor(): Promise<RunnerDescriptor | null> {
    try {
      const raw = await fsp.readFile(path.join(this.opts.root, 'runner.json'), 'utf8');
      const parsed = JSON.parse(raw) as RunnerDescriptor;
      return typeof parsed.port === 'number' && typeof parsed.token === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  private async alive(peer: RunnerDescriptor): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      const res = await fetch(`${this.base()}/health`, { headers: this.headers(), signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Polls while anything is live; stops itself when the board is quiet. */
  private pollWhile(runs: readonly RunInfo[]): void {
    const live = runs.some((r) => !['done', 'stopped', 'failed', 'detached'].includes(r.state));
    if (live && this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.runs(), 2_000);
    } else if (!live && this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async get<T>(pathname: string): Promise<T> {
    const res = await fetch(`${this.base()}${pathname}`, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`${pathname} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async post<T>(pathname: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base()}${pathname}`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }
}
