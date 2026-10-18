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
  ChainConfig,
  ChainMaster,
  ChainStatus,
  ColumnMode,
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
  /** Pushed whenever the polled run list or chain state differs — the board re-renders. */
  readonly onFleetChanged: (fleet: FleetSnapshot) => void;
}

/** What the plugin pushes to the renderer: the runs plus the chain's control state. */
export interface FleetSnapshot {
  readonly runs: readonly RunInfo[];
  readonly chain: ChainStatus | null;
}

type StartOutcome = { readonly ok: true; readonly run: RunInfo } | { readonly ok: false; readonly error: string };

/**
 * The retirement decision's ordered core: retire only a daemon whose
 * build stamp is OLDER than the client's own. Two Drey checkouts share
 * one fleet root, so an inequality would have the instances retire each
 * other's runner in an endless loop — the newest build's daemon serves
 * both, and only a genuinely outdated one is replaced.
 */
export function isOlderBuild(daemonBuild: string, clientBuild: string): boolean {
  const daemon = Date.parse(daemonBuild);
  const client = Date.parse(clientBuild);
  return Number.isFinite(daemon) && Number.isFinite(client) && daemon < client;
}

/**
 * A daemon that reports no build stamp predates the stamp itself, so it is
 * older than every build that can ask — it must be retired, not trusted.
 */
export function isStaleDaemon(daemonBuild: string | undefined, clientBuild: string | null): boolean {
  if (daemonBuild === undefined) {
    return clientBuild !== null;
  }
  return clientBuild !== null && isOlderBuild(daemonBuild, clientBuild);
}

export class FleetClient {
  private descriptor: RunnerDescriptor | null = null;
  private spawning: Promise<boolean> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotJson = '';

  constructor(private readonly opts: FleetClientOpts) {}

  /** All runs plus the chain state, newest first; empty/null when no
   *  runner is alive (never throws, never spawns — the runner comes up
   *  on `start` only). */
  async runs(): Promise<readonly RunInfo[]> {
    try {
      if (!(await this.withRunner())) {
        this.push({ runs: [], chain: null });
        return [];
      }
      const [data, chain] = await Promise.all([
        this.get<{ runs: RunInfo[] }>('/status'),
        this.get<ChainStatus>('/chain').catch(() => null),
      ]);
      this.push({ runs: data.runs, chain });
      this.startPolling();
      return data.runs;
    } catch {
      return [];
    }
  }

  private push(fleet: FleetSnapshot): void {
    const json = JSON.stringify(fleet);
    if (json === this.lastSnapshotJson) {
      return;
    }
    this.lastSnapshotJson = json;
    this.opts.onFleetChanged(fleet);
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

  /** Takeover control of a live run: take over, interrupt the turn, hand back. */
  async control(
    action: 'takeover' | 'interrupt' | 'release',
    runId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.withRunner())) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return this.post<{ ok: boolean; error?: string }>(`/${action}`, { runId });
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

  /** The daemon's recent log lines (the chain-log view), or null. */
  async log(): Promise<string | null> {
    try {
      if (!(await this.withRunner())) {
        return null;
      }
      const res = await fetch(`${this.base()}/log`, { headers: this.headers() });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  // --- the chain (M85, ADR-0077) -----------------------------------------

  /** The chain's control state, or null when no runner is alive. */
  async chainStatus(): Promise<ChainStatus | null> {
    try {
      if (await this.withRunner()) {
        return await this.get<ChainStatus>('/chain');
      }
    } catch {
      // fall through
    }
    return null;
  }

  /** Points the runner at a tickets vault. Never spawns: a snapshot
   *  read must not bring a runner up; the next explicit interaction
   *  will. A configured chain re-points here when the board moves. */
  async configureChain(config: ChainConfig): Promise<void> {
    try {
      if (await this.withRunner()) {
        await this.post('/chain/config', config);
      }
    } catch {
      // the runner is gone; the next start re-configures
    }
  }

  async setMaster(mode: ChainMaster): Promise<ChainStatus | null> {
    if (!(await this.ensureRunner())) {
      return null;
    }
    try {
      return await this.post<ChainStatus>('/chain/master', { mode });
    } catch {
      return null;
    }
  }

  async setColumn(phase: string, mode: ColumnMode): Promise<ChainStatus | null> {
    if (!(await this.ensureRunner())) {
      return null;
    }
    try {
      return await this.post<ChainStatus>('/chain/column', { phase, mode });
    } catch {
      return null;
    }
  }

  async stopColumn(phase: string): Promise<ChainStatus | null> {
    if (!(await this.ensureRunner())) {
      return null;
    }
    try {
      return await this.post<ChainStatus>('/chain/column', { phase, stop: true });
    } catch {
      return null;
    }
  }

  /** Notaus: halt the chain and abort every live run. */
  async abortAll(): Promise<ChainStatus | null> {
    if (!(await this.ensureRunner())) {
      return null;
    }
    try {
      return await this.post<ChainStatus>('/chain/abort', {});
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

  /** Descriptor file → health check → build check → spawn the sibling
   *  when all fail. Spawn-capable: only `start` may bring the runner up. */
  private async ensureRunner(): Promise<boolean> {
    if (this.descriptor !== null && (await this.alive(this.descriptor))) {
      if (await this.isStale(this.descriptor)) {
        await this.retireStale(this.descriptor);
        return this.spawnRunner();
      }
      return true;
    }
    this.descriptor = await this.readDescriptor();
    if (this.descriptor !== null && (await this.alive(this.descriptor))) {
      if (await this.isStale(this.descriptor)) {
        await this.retireStale(this.descriptor);
        return this.spawnRunner();
      }
      return true;
    }
    return this.spawnRunner();
  }

  /** Read-only adoption: talk to a runner that is already alive, never spawn. */
  private async withRunner(): Promise<boolean> {
    if (this.descriptor !== null && (await this.alive(this.descriptor))) {
      if (await this.isStale(this.descriptor)) {
        // The read-only path never spawns; the next explicit interaction
        // starts the new build.
        await this.retireStale(this.descriptor);
        return false;
      }
      return true;
    }
    this.descriptor = await this.readDescriptor();
    return this.descriptor !== null && (await this.alive(this.descriptor));
  }

  /**
   * True when a healthy runner was booted from an older build of the
   * entry script: the daemon stamps the script's mtime at boot, and the
   * client compares it with the file on disk now. Ordered on purpose
   * (`isOlderBuild`): two Drey checkouts can share one fleet root — an
   * inequality would have them retire each other's runner forever. Only
   * a daemon OLDER than this build is stale; a newer one serves this
   * instance too.
   */
  private async isStale(peer: RunnerDescriptor): Promise<boolean> {
    const mine = await fsp
      .stat(this.opts.runnerScript)
      .then((s) => s.mtime.toISOString())
      .catch(() => null);
    return isStaleDaemon(peer.build, mine);
  }

  /** Asks a stale runner to exit, waits until it is actually gone, and
   *  only then clears the descriptor so the next start can respawn. The
   *  wait matters: the runner's boot guard bounces a successor while
   *  the old peer still answers. */
  private async retireStale(peer: RunnerDescriptor): Promise<void> {
    this.opts.log('the fleet runner predates this build — restarting it', 'warn');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      await fetch(`${this.base()}/shutdown`, { method: 'POST', headers: this.headers(), signal: controller.signal });
      clearTimeout(timer);
    } catch {
      // a daemon that will not take the call is dead to us either way —
      // the next spawn takes over the stale descriptor
    }
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      const alive = await fetch(`${this.base()}/health`, { headers: this.headers(), signal: controller.signal })
        .then((r) => r.ok)
        .catch(() => false);
      clearTimeout(timer);
      if (!alive) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.descriptor = null;
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

  /**
   * Keeps the board's view of the fleet fresh for as long as the plugin
   * lives. The daemon dispatches on its own and can come and go (a build
   * change retires it, a restart brings it back), so a poll that only runs
   * while this client already knows of a live run misses exactly the runs
   * the owner wants to see: the board stayed idle while the log showed the
   * run. A poll round is one local request, and it pushes only on change.
   */
  startPolling(): void {
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.runs(), 2_500);
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
