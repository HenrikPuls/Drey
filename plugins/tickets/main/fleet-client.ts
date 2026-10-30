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
  QuestionAnswers,
  RunInfo,
  RunRequest,
  RunnerDescriptor,
} from './fleet/protocol';
import { fleetBuildStamp, isStaleDaemon } from './fleet/build-stamp';

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

export class FleetClient {
  private descriptor: RunnerDescriptor | null = null;
  private spawning: Promise<boolean> | null = null;
  private retiring: Promise<boolean> | null = null;
  private stampCache: { readonly mtimeMs: number; readonly stamp: string } | null = null;
  /** The last "handover deferred" reason logged — logged once, not every poll. */
  private deferNote: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotJson = '';

  constructor(private readonly opts: FleetClientOpts) {}

  /** All runs plus the chain state, newest first; empty/null when no
   *  runner is alive (never throws, never spawns — the runner comes up
   *  on `start` only). */
  async runs(): Promise<readonly RunInfo[]> {
    try {
      if (!(await this.withRunner())) {
        // No daemon: the finished runs are still on disk, so their logs stay reachable.
        const history = await this.readHistory();
        this.push({ runs: history, chain: null });
        return history;
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

  /** The persisted runs (`runs/<id>/run.json`), newest first. Without a
   *  runner nothing supervises them, so a record that was still live reads
   *  as `stopped` (no lane for it). */
  private async readHistory(): Promise<RunInfo[]> {
    const runsDir = path.join(this.opts.root, 'runs');
    const ids = await fsp.readdir(runsDir).catch(() => [] as string[]);
    const found: RunInfo[] = [];
    for (const id of ids) {
      try {
        const stored = JSON.parse(await fsp.readFile(path.join(runsDir, id, 'run.json'), 'utf8')) as {
          info?: RunInfo;
        };
        if (stored.info === undefined) {
          continue;
        }
        const settled = ['done', 'stopped', 'failed', 'detached'].includes(stored.info.state);
        found.push(settled ? stored.info : { ...stored.info, state: 'stopped' });
      } catch {
        // an unreadable record is skipped
      }
    }
    return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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

  /** A file for the takeover prompt: stored in the run's worktree, its path comes back. */
  async attach(runId: string, name: string, data: string): Promise<{ ok: boolean; error?: string; path?: string }> {
    if (!(await this.withRunner())) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return this.post<{ ok: boolean; error?: string; path?: string }>('/attach', { runId, name, data });
  }

  /** The owner's answer to a worker's pending approval (req-57). */
  async answerPermission(runId: string, decision: 'once' | 'always' | 'reject'): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.withRunner())) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return this.post<{ ok: boolean; error?: string }>('/permission', { runId, decision });
  }

  /** The owner's choices for a worker's question form (OpenCode's `question` tool). */
  async answerQuestion(runId: string, answers: QuestionAnswers): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.withRunner())) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return this.post<{ ok: boolean; error?: string }>('/answer', { runId, answers });
  }

  /** Takeover control of a live run: take over, interrupt the turn, hand back. */
  async control(
    action: 'takeover' | 'interrupt' | 'release' | 'resume',
    runId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    // Resuming an ended run is the one control that may find no daemon
    // alive (the run is history): it brings one up, like a start does.
    const up = action === 'resume' ? await this.ensureRunner() : await this.withRunner();
    if (!up) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return this.post<{ ok: boolean; error?: string }>(`/${action}`, { runId });
  }

  /** The run's stream so far (the watch view's text), or null. */
  async stream(runId: string): Promise<string | null> {
    try {
      if (!(await this.withRunner())) {
        return /^[\w.-]+$/.test(runId)
          ? await fsp.readFile(path.join(this.opts.root, 'runs', runId, 'stream.jsonl'), 'utf8').catch(() => null)
          : null;
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
    if (this.descriptor === null || !(await this.alive(this.descriptor))) {
      this.descriptor = await this.readDescriptor();
      if (this.descriptor === null || !(await this.alive(this.descriptor))) {
        return this.spawnRunner();
      }
    }
    if (await this.isStale(this.descriptor)) {
      // A deferred handover leaves the old runner serving for now.
      return (await this.retireStale(this.descriptor)) ? this.spawnRunner() : true;
    }
    return true;
  }

  /** Read-only adoption: talk to a runner that is already alive, never
   *  spawn one from nothing. Replacing a retired one is the exception:
   *  its handed-over runs wait for a successor to take them back. */
  private async withRunner(): Promise<boolean> {
    if (this.descriptor !== null && (await this.alive(this.descriptor))) {
      if (await this.isStale(this.descriptor)) {
        return (await this.retireStale(this.descriptor)) ? this.spawnRunner() : true;
      }
      return true;
    }
    this.descriptor = await this.readDescriptor();
    return this.descriptor !== null && (await this.alive(this.descriptor));
  }

  /**
   * True when a healthy runner serves other fleet code than this build
   * and is older (`isStaleDaemon`, req-51): the stamp is a hash of the
   * compiled fleet code, so a rebuild that changed none of it keeps the
   * runner and its workers. Ordered on purpose: two Drey checkouts can
   * share one fleet root — only a daemon OLDER than this build is
   * stale; a newer one serves this instance too.
   */
  private async isStale(peer: RunnerDescriptor): Promise<boolean> {
    return isStaleDaemon(peer.build, await this.ownBuild());
  }

  /** This build's stamp, re-hashed only when the entry file was rewritten
   *  (every build rewrites it) — the poll asks every few seconds. */
  private async ownBuild(): Promise<string | null> {
    const stat = await fsp.stat(this.opts.runnerScript).catch(() => null);
    if (stat === null) {
      return null;
    }
    if (this.stampCache?.mtimeMs !== stat.mtimeMs) {
      const stamp = await fleetBuildStamp(this.opts.runnerScript).catch(() => null);
      if (stamp === null) {
        return null;
      }
      this.stampCache = { mtimeMs: stat.mtimeMs, stamp };
    }
    return this.stampCache.stamp;
  }

  /**
   * Asks a stale runner to hand its runs over and exit (req-51): its
   * workers are not stopped — the successor re-attaches or resumes them.
   * A runner with a run in its gate (or being stopped) refuses: false,
   * and it serves on until a later poll finds it free. Otherwise waits
   * until the old runner is actually gone and clears the descriptor so a
   * successor can come up — the runner's boot guard bounces a successor
   * while the old peer still answers, and the old one answers until its
   * handover records are written.
   */
  private retireStale(peer: RunnerDescriptor): Promise<boolean> {
    // The poll and an explicit interaction can both find the stale peer:
    // one handover, both wait for it.
    this.retiring ??= this.handOver(peer).finally(() => {
      this.retiring = null;
    });
    return this.retiring;
  }

  private async handOver(peer: RunnerDescriptor): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      const res = await fetch(`${this.base()}/shutdown`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ handover: true }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const note = body.error ?? 'the runner is busy';
        if (note !== this.deferNote) {
          this.deferNote = note;
          this.opts.log(`the fleet runner predates this build — handover deferred: ${note}`, 'warn');
        }
        return false;
      }
    } catch {
      // a daemon that will not take the call is dead to us either way —
      // the next spawn takes over the stale descriptor
    }
    this.deferNote = null;
    this.opts.log(`the fleet runner predates this build — it hands its runs over to a new one (pid ${peer.pid})`, 'warn');
    const deadline = Date.now() + 20_000;
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
    return true;
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
