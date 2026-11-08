/**
 * The engine's side of the fleet (ADR-0075, M84): find or wake the Crew
 * runner, then proxy Run/Stop/Steer/Watch to its loopback HTTP surface.
 * Since Drey Service (req-164, ADR-0092) the runner is a component of the
 * same process as the engine: the {@link RunnerLocator} says where it
 * listens (null while it sleeps) and wakes it — nothing is spawned here,
 * and a stale build is the service's matter (Drey hands the whole service
 * over), not this client's.
 *
 * The engine never touches worker pipes; it sees runs through
 * `GET /status` (polled onto the board while anything is live) and the
 * stream files via `GET /stream/:id` for the watch view.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { recordedWorkerPids, workerGone, type ExecFn } from '../fleet/procs';
import type {
  AutopilotRecord,
  AutopilotRefusal,
  ChainConfig,
  ChainStoreConfig,
  ChainMaster,
  ChainStatus,
  ColumnMode,
  QuestionAnswers,
  RunInfo,
  RunRequest,
  RunnerDescriptor,
} from '../fleet/protocol';

/** The process probes' exec: no shell, no window. */
const plainExec: ExecFn = async (cmd, args) => (await promisify(execFile)(cmd, [...args], { windowsHide: true })).stdout;

/**
 * Where the Crew runner listens, and how it is woken (req-164). Drey
 * Service's runner component implements it; a spec hands a fixed one.
 */
export interface RunnerLocator {
  /** The runner's endpoint while it is awake, null while it sleeps. Never starts it. */
  current(): Promise<RunnerDescriptor | null>;
  /** Starts the runner when it sleeps (D-51's on-demand start); a failure says why. */
  wake(): Promise<{ readonly ok: true; readonly descriptor: RunnerDescriptor } | { readonly ok: false; readonly error: string }>;
}

export interface FleetClientOpts {
  /** The fleet root — `<engine home>/fleet` (runs, worktrees, chain state). */
  readonly root: string;
  /** The runner component (req-164): its endpoint and its wake. */
  readonly runner: RunnerLocator;
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Pushed whenever the polled run list or chain state differs — the board re-renders. */
  readonly onFleetChanged: (fleet: FleetSnapshot) => void;
  /** Test seam over the process probes of a detached record (D-34). */
  readonly exec?: ExecFn;
}

/** What the plugin pushes to the renderer: the runs plus the chain's control state. */
export interface FleetSnapshot {
  readonly runs: readonly RunInfo[];
  readonly chain: ChainStatus | null;
}

type StartOutcome = { readonly ok: true; readonly run: RunInfo } | { readonly ok: false; readonly error: string };

/** What `retireIfIdle` found (req-110): gone, or why the runner stays. */
export type RetireReply =
  | { readonly ok: true; readonly exiting: true }
  | { readonly ok: true; readonly exiting: false; readonly reason: 'live runs' | 'autopilot' | 'down' | 'unsupported' }
  | { readonly ok: false; readonly error: string };

export class FleetClient {
  private descriptor: RunnerDescriptor | null = null;
  private spawning: Promise<boolean> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotJson = '';
  private readonly detachedProbes = new Map<string, { at: number; gone: boolean }>();
  /** Why the last runner start failed (D-51); cleared when a runner is adopted. */
  private lastRunnerFailure: string | null = null;

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
        const dead = stored.info.state === 'detached' && (await this.detachedWorkerGone(id, stored.info));
        found.push(settled && !dead ? stored.info : { ...stored.info, state: 'stopped' });
      } catch {
        // an unreadable record is skipped
      }
    }
    return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** D-34: with no runner to settle it, a detached record whose worker is gone only reads as over. Asked at most every 30 s per run: the board polls. */
  private async detachedWorkerGone(id: string, info: RunInfo): Promise<boolean> {
    const cached = this.detachedProbes.get(id);
    const now = Date.now();
    if (cached !== undefined && (cached.gone || now - cached.at < 30_000)) {
      return cached.gone;
    }
    const pids = await recordedWorkerPids(path.join(this.opts.root, 'runs', id), info.pid);
    const gone = await workerGone(pids, Date.parse(info.lastActivity), this.opts.exec ?? plainExec);
    this.detachedProbes.set(id, { at: now, gone });
    return gone;
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
      return { ok: false, error: this.runnerDownReason() };
    }
    return this.post<StartOutcome>('/start', request);
  }

  async stop(runId: string, reason: string | null): Promise<{ ok: boolean; error?: string }> {
    if (!(await this.withRunner())) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    return this.post<{ ok: boolean; error?: string }>('/stop', { runId, reason });
  }

  /**
   * A message to a run (req-154): a chat with a worker is no Autopilot
   * matter, so the runner is started on demand when it is down — a
   * reopenable run resumes under the fresh runner. Its idle exit (req-110)
   * still applies once the run settles again.
   */
  async send(runId: string, text: string): Promise<{ ok: boolean; error?: string; rung?: string }> {
    if (!(await this.ensureRunner())) {
      return { ok: false, error: this.runnerDownReason() };
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

  /** The owner's answer to a worker's pending approval (req-64). */
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
    action: 'takeover' | 'interrupt' | 'softpause' | 'release' | 'resume',
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

  /** E14-5b: releases the agent claims of this host that no live run of the runner holds. */
  async releaseLeftoverClaims(
    store: ChainStoreConfig,
    retreat: Readonly<Record<string, string | null>>,
  ): Promise<{ readonly ok: true; readonly released: readonly string[]; readonly skipped: readonly { readonly id: string; readonly reason: string }[] } | { readonly ok: false; readonly error: string }> {
    if (!(await this.ensureRunner())) {
      return { ok: false, error: 'the fleet runner is not running' };
    }
    try {
      return await this.post('/claims/release-leftovers', { dk: store, retreat });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

  /**
   * The Autopilot switch (req-95). Re-reads the fleet right after, so every
   * device hears the change now — and starts the poll that carries the
   * runner's own later change (a resume time firing) to them.
   */
  async setAutopilot(record: AutopilotRecord): Promise<ChainStatus | AutopilotRefusal> {
    const reply = await this.postToRunner<ChainStatus | AutopilotRefusal>('/chain/autopilot', record);
    if (!reply.ok) {
      // D-51: the refusal names why — the spawn failure, or what the request ran into.
      return { ok: false, error: reply.error, code: 'runner_down' };
    }
    await this.runs();
    return reply.value;
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

  /** The persona pause (U4): a paused persona's tickets hold until played again. */
  async setPersonaPaused(persona: string, paused: boolean): Promise<ChainStatus | null> {
    if (!(await this.ensureRunner())) {
      return null;
    }
    try {
      return await this.post<ChainStatus>('/chain/persona-pause', { persona, paused });
    } catch {
      return null;
    }
  }

  /**
   * Drey is gone (req-110): asks a live runner to leave if nothing needs it.
   * The runner decides — a live run or an On/Paused Autopilot keeps it and
   * the reply says why. Never spawns, never retires a stale build on the
   * way (that would spawn a successor to retire), and a runner from before
   * the route (404) is left alone: its idle span ends it.
   */
  async retireIfIdle(): Promise<RetireReply> {
    const peer = await this.adoptAlive();
    if (peer === null) {
      return { ok: true, exiting: false, reason: 'down' };
    }
    try {
      const res = await fetch(`${this.base()}/retire-if-idle`, { method: 'POST', headers: this.headers() });
      if (res.status === 404) {
        this.opts.log('the fleet runner predates retire-if-idle — it leaves after its idle span', 'warn');
        return { ok: true, exiting: false, reason: 'unsupported' };
      }
      const body = (await res.json()) as { exiting?: unknown; reason?: unknown };
      if (body.exiting === true) {
        this.opts.log(`fleet runner retired (pid ${peer.pid}) — Drey closed and nothing is live`);
        this.descriptor = null;
        return { ok: true, exiting: true };
      }
      const reason = body.reason === 'live runs' || body.reason === 'autopilot' ? body.reason : 'unsupported';
      this.opts.log(`fleet runner stays after Drey closed: ${reason}`);
      return { ok: true, exiting: false, reason };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The descriptor's runner when it answers `/health`; nothing else — no spawn, no handover. */
  private async adoptAlive(): Promise<RunnerDescriptor | null> {
    if (this.descriptor === null || !(await this.alive(this.descriptor))) {
      this.descriptor = await this.readDescriptor();
      if (this.descriptor === null || !(await this.alive(this.descriptor))) {
        return null;
      }
    }
    return this.descriptor;
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

  /** The runner's endpoint, or a wake when it sleeps (D-51). Spawn-capable
   *  in the old sense: only writes and starts may bring the runner up. */
  private async ensureRunner(): Promise<boolean> {
    if (this.descriptor === null || !(await this.alive(this.descriptor))) {
      this.descriptor = await this.readDescriptor();
      if (this.descriptor === null || !(await this.alive(this.descriptor))) {
        return this.spawnRunner();
      }
    }
    return true;
  }

  /** Read-only adoption: talk to a runner that is awake, never wake one. */
  private async withRunner(): Promise<boolean> {
    if (this.descriptor !== null && (await this.alive(this.descriptor))) {
      return true;
    }
    this.descriptor = await this.readDescriptor();
    return this.descriptor !== null && (await this.alive(this.descriptor));
  }

  /** A run start's or a message's refusal without a runner: the last start failure, else the plain fact. */
  private runnerDownReason(): string {
    return this.lastRunnerFailure !== null ? `the fleet runner could not be started: ${this.lastRunnerFailure}` : 'the fleet runner is not running';
  }

  /** The Autopilot refusal's reason (`runner_down` already says "could not be started"): the bare cause. */
  private runnerFailureCause(): string {
    return this.lastRunnerFailure ?? 'the fleet runner is not running';
  }

  /**
   * A write that brings the runner up when it is down (D-51). A runner that
   * answers "leaving" (req-110: it goes to sleep after an Off with nothing
   * live) is waited out and woken again, once; a request the runner died
   * under is retried the same way. Never null: a failure says why.
   */
  private async postToRunner<T>(
    pathname: string,
    body: unknown,
  ): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }> {
    let lastError = this.runnerFailureCause();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await this.ensureRunner())) {
        return { ok: false, error: this.runnerFailureCause() };
      }
      try {
        const res = await fetch(`${this.base()}${pathname}`, {
          method: 'POST',
          headers: { ...this.headers(), 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const reply = (await res.json()) as T & { code?: unknown };
        if (res.status === 503 && reply.code === 'leaving') {
          lastError = 'the fleet runner was leaving and no new one came up';
          await this.waitGone();
          continue;
        }
        return { ok: true, value: reply };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (this.descriptor !== null && (await this.alive(this.descriptor))) {
          return { ok: false, error: lastError };
        }
        this.descriptor = null;
      }
    }
    return { ok: false, error: lastError };
  }

  /** Waits (bounded) until the current runner stops answering, then forgets it. */
  private async waitGone(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && this.descriptor !== null && (await this.alive(this.descriptor))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.descriptor = null;
  }

  /** Wakes the runner component (req-164: in the service's own process, no spawn). One wake at a time. */
  private async spawnRunner(): Promise<boolean> {
    if (this.spawning !== null) {
      return this.spawning;
    }
    this.spawning = (async (): Promise<boolean> => {
      try {
        const woke = await this.opts.runner.wake();
        if (woke.ok) {
          this.descriptor = woke.descriptor;
          this.opts.log(`Crew runner awake (port ${woke.descriptor.port})`);
          this.lastRunnerFailure = null;
          return true;
        }
        this.lastRunnerFailure = woke.error;
        this.opts.log(`the fleet runner could not be started: ${woke.error}`, 'warn');
        return false;
      } catch (error) {
        this.lastRunnerFailure = error instanceof Error ? error.message : String(error);
        this.opts.log(`the fleet runner could not be started: ${this.lastRunnerFailure}`, 'warn');
        return false;
      } finally {
        this.spawning = null;
      }
    })();
    return this.spawning;
  }

  private async readDescriptor(): Promise<RunnerDescriptor | null> {
    return this.opts.runner.current().catch(() => null);
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
