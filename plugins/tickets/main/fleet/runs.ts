/**
 * The run supervisor (ADR-0075, milestone 84): one live run per ticket,
 * one worktree per run, the machine gate after the worker exits, and
 * the ticket-file stamps with the board's exact transition semantics
 * (move + stamp + log + one commit — ADR-0076's single-writer rule).
 *
 * State lives in files under the fleet root: `runs/<id>/run.json` is
 * the record, `runs/<id>/stream.jsonl` the file-backed stdout anyone
 * can tail (Drey and a plain terminal alike). The supervisor's ticket
 * writes reuse the compiled siblings of the plugin bundle — the same
 * patch helpers Drey's board service uses, so the semantics cannot
 * drift.
 */
import { exec as nodeExec, execFile as nodeExecFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { parseOrderFile, rewriteOrderSection } from '../ticket-board';
import { acceptanceCommands, patchTicketFile, ticketPathParts } from '../ticket-files';
import { TicketsGit } from '../tickets-git';
import { answersFromText, answersText, ZERO_USAGE, type NormalizedEvent, type ProviderAdapter, type UsageTotals, type WorkerHandle } from './providers';
import { COMPACT_CAPABILITY, HANDOVER_CANDIDATE_STATES, resolveHandover, type HandoverCandidate, type HandoverDecision } from './handover';
import { killTreeGuarded, processAlive, processStartMs, type ExecFn } from './procs';
import {
  DEFAULT_FLEET_HANDOVER,
  type FleetHandoverConfig,
  type PermissionDecision,
  type QuestionAnswers,
  type RunInfo,
  type RunRequest,
  type RunState,
  type SteerRung,
} from './protocol';
import {
  normalizeForMatch,
  prepareWorktree as defaultPrepareWorktree,
  type LinkReport,
  type PreparedWorktree,
} from './worktrees';
import { capTail, SANITY_CAP } from './capping';
import { TelemetryFold, type RunTelemetry } from './telemetry';

const execAsync = promisify(nodeExec);
const execFileAsync = promisify(nodeExecFile);

/**
 * The process probes' exec (liveness, start time): the program and its
 * arguments stay separate — no shell, no re-parsing. Joining them into one
 * command line broke `tasklist /FI "PID eq 42"` (the quotes are the filter's
 * one argument): the probe failed, every live worker looked dead, and the
 * lease reaper killed healthy runs.
 */
export const probeExec =
  (cwd: string): ExecFn =>
  async (cmd, args) => {
    const { stdout } = await execFileAsync(cmd, [...args], { cwd, windowsHide: true });
    return stdout;
  };

/**
 * The gate's shell exec — the owner's commands run with a shell, 30
 * minutes each. The orchestrator's `ci` handover check (M85) uses the
 * same semantics.
 */
export const execShell = (command: string, cwd: string): Promise<void> =>
  execAsync(command, { cwd, windowsHide: true, timeout: 30 * 60_000 }).then(() => undefined);

export interface StoredRun {
  readonly request: RunRequest;
  readonly info: RunInfo;
  /** Set by a runner that retired for a newer build without stopping the run (req-51). */
  readonly handover?: RunHandover;
  /** A resumed session's spend before this run (req-53) — a reattach or resume in place keeps subtracting it. */
  readonly usageBase?: UsageTotals;
}

/**
 * How a retiring runner left a live run for its successor (req-51):
 * `reattach` — the worker lives on and the successor binds to it
 * (OpenCode's server); `resume` — the worker was stopped (its pipes die
 * with the runner, Claude Code) and the successor resumes the provider
 * session in place, under the same run id. `pidStartedMs` is the
 * worker's creation time, the pid-reuse guard of the successor's kill.
 */
export interface RunHandover {
  readonly mode: 'reattach' | 'resume';
  readonly at: string;
  readonly pidStartedMs: number | null;
}

/** The opening line of a session resumed after a runner handover. */
export const HANDOVER_CONTINUE =
  'The fleet runner was replaced by a newer build and your session was resumed; your last turn may have been cut short. ' +
  'Continue the step where you left off; your original brief is earlier in this conversation.';

/** The same for a run the owner holds: the worker picks up the owner's request, then waits. */
export const HANDOVER_HELD =
  'The fleet runner was replaced by a newer build and your session was resumed; your last turn may have been cut short. ' +
  'If you were in the middle of something the owner asked, finish it; otherwise reply with one short line that you are back, then wait for their instructions.';

export type StartOutcome = { readonly ok: true; readonly run: RunInfo } | { readonly ok: false; readonly error: string };

export type StopOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** One run as the supervisor holds it: the record plus its request
 *  (the orchestrator's port exposes this to count pool slots). */
export interface SupervisorRecord {
  readonly info: RunInfo;
  readonly request: RunRequest;
}

export interface RunSupervisorDeps {
  readonly root: string;
  readonly adapter: ProviderAdapter;
  /** git executable for the ticket commits and worktree ops. */
  readonly git: string;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
  /** Test seam over the machine gate's shell exec. */
  readonly exec?: ExecFn;
  /** Test seam over the gate's shell commands (cwd = the worktree). */
  readonly execShell?: (command: string, cwd: string) => Promise<void>;
  /** Test seam over worktree preparation. */
  readonly prepareWorktree?: (request: RunRequest, worktreePath: string) => Promise<PreparedWorktree>;
  /** Test seam over the tickets repo's git (the spec recorder). */
  readonly ticketsGit?: Pick<TicketsGit, 'run' | 'locate' | 'commitPaths' | 'push'>;
  /** Run settled (terminal): the orchestrator's slot-freed trigger (M85). */
  readonly onRunSettled?: (info: RunInfo) => void;
  /**
   * The quality rungs (M85, flagged off): on a green gate, return an
   * instruction to re-run the ticket with — a second worker reviews the
   * branch before the move — or null to move as normal. Called once per
   * run; the audit round never samples again.
   */
  readonly secondOpinion?: (request: RunRequest) => Promise<string | null>;
}

interface LiveRun {
  info: RunInfo;
  readonly request: RunRequest;
  /** Where the ticket file sits NOW — a success move changes both. */
  currentRelPath: string;
  currentPhase: string;
  readonly dir: string;
  handle: WorkerHandle | null;
  readonly startedAtMs: number;
  /** The worker exited and the machine gate is deciding — the reaper stands down. */
  gating: boolean;
  /** The second-opinion round ran (the move follows its own gate). */
  audited: boolean;
  /** The worker finished its turn — the adapter's `result` event, the agent-done signal. */
  agentDone: boolean;
  /** Folds the run's token telemetry (T-0048) out of every stream event. */
  telemetry: TelemetryFold;
  /** Why the owner stopped the run — becomes the ticket Log line when the run ends. */
  stopNote?: string;
  /** An ended run's session the owner reopened: held from the start, no gate and no move at its end. */
  reopened?: boolean;
  /** The runner is retiring and left this run to its successor: its worker's exit decides nothing here. */
  handover?: RunHandover;
  /** The resumed session's spend before this run, once the adapter read it (req-53). */
  usageBase?: UsageTotals;
  /**
   * A failed resume is being replaced by a fresh worker under the same
   * run id (T-0049): the dying worker's exit decides nothing while this
   * is set.
   */
  fallbackActive?: boolean;
}

/** The telemetry a persisted record carries, for restoring a fold (an adopted run). */
function telemetryOf(info: RunInfo): RunTelemetry | undefined {
  if (
    info.usage === undefined &&
    info.turns === undefined &&
    info.readCalls === undefined &&
    info.lastTurnContext === undefined &&
    info.tokensBeforeFirstWrite === undefined
  ) {
    return undefined;
  }
  return {
    usage: info.usage ?? { input: null, cacheRead: null, cacheCreation: null, output: null },
    lastTurnContext: info.lastTurnContext ?? null,
    turns: info.turns ?? 0,
    readCalls: info.readCalls ?? 0,
    tokensBeforeFirstWrite: info.tokensBeforeFirstWrite ?? null,
  };
}

/** What a takeover call answers. */
export type TakeoverOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Whether the run is mid-turn — actually working (req-67). A turn the
 * provider has not reported yet presumes working (a run starts busy);
 * a wait for the owner (req-64) is never working.
 */
function isExecuting(info: RunInfo): boolean {
  return (info.waiting ?? null) === null && (info.turn ?? 'busy') === 'busy';
}

/**
 * Closes the run's open working span at `at` (req-67): the elapsed clock
 * freezes from here on. No-op while nothing is open — standing, ended,
 * or a record that predates the exec fields.
 */
function closeExecSpan(info: RunInfo, at: string): RunInfo {
  if (info.execSince === undefined || info.execSince === null) {
    return info;
  }
  const from = Date.parse(info.execSince);
  const closed = Number.isNaN(from) ? 0 : Math.max(0, Date.parse(at) - from);
  return { ...info, execMs: (info.execMs ?? 0) + closed, execSince: null };
}

/** The largest file the takeover tab attaches. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_DIR = '.drey-attachments';

const TERMINAL: readonly RunState[] = ['done', 'stopped', 'failed'];

/** 331122 -> `331k`, 3_400_000 -> `3.4M`: the Log's short token counts. */
function tokenWords(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);
}

/**
 * What the run used, for the ticket's Log line: tokens always (input
 * counts cache reads, named when the provider reported any), cost only
 * when the provider reports one — a flat coding plan reports 0, which
 * says nothing and is left out.
 */
export function usageSummary(info: Pick<RunInfo, 'tokensIn' | 'tokensOut' | 'cacheReadTokens' | 'costUsd'>): string {
  if (info.tokensIn === 0 && info.tokensOut === 0) {
    return '';
  }
  const cached = (info.cacheReadTokens ?? 0) > 0 ? ` (${tokenWords(info.cacheReadTokens ?? 0)} cached)` : '';
  const cost = info.costUsd !== null && info.costUsd > 0 ? ` · $${info.costUsd.toFixed(2)}` : '';
  return ` — ${tokenWords(info.tokensIn)} in${cached} / ${tokenWords(info.tokensOut)} out${cost}`;
}

/** The stream's setup line for the repo's `link:` folders (req-56). */
export function linkNote(report: LinkReport): string {
  const parts = [
    report.linked.length > 0 ? `linked ${report.linked.join(', ')}` : '',
    report.present.length > 0 ? `already there ${report.present.join(', ')}` : '',
    ...report.skipped.map((s) => `left out ${s.path} (${s.reason})`),
  ].filter((part) => part !== '');
  return `worktree links: ${parts.join('; ')}`;
}

export class RunSupervisor {
  private readonly runs = new Map<string, LiveRun>();
  /** Set by `handOver`: this runner is going, it starts nothing new. */
  private retiring = false;
  /**
   * The handover thresholds (T-0049), pushed by the runner whenever the
   * plugin's chain config names them; the defaults until then.
   */
  private handoverConfig: FleetHandoverConfig = DEFAULT_FLEET_HANDOVER;
  private readonly git: Pick<TicketsGit, 'run' | 'locate' | 'commitPaths' | 'push'>;
  private readonly now: () => Date;
  private readonly exec: ExecFn;
  private readonly prepareWorktree: (request: RunRequest, worktreePath: string) => Promise<PreparedWorktree>;

  constructor(private readonly deps: RunSupervisorDeps) {
    this.git = deps.ticketsGit ?? new TicketsGit(() => deps.git);
    this.now = deps.now ?? ((): Date => new Date());
    this.exec = deps.exec ?? probeExec(this.deps.root);
    this.prepareWorktree =
      deps.prepareWorktree ??
      ((request, worktreePath) =>
        defaultPrepareWorktree(this.git, request, worktreePath, this.now, (p) => this.isWorktreeLive(p)));
  }

  /** The handover thresholds the plugin configured (T-0049) — idempotent, applied to the next start. */
  setHandoverConfig(config: FleetHandoverConfig): void {
    this.handoverConfig = config;
  }

  /**
   * Loads persisted runs after a runner restart. Terminal records come
   * back as history. A non-terminal record whose worker still lives is
   * taken back (`reattach`, OpenCode: its server, address and credential
   * were recorded); otherwise it has no supervised worker anymore, so it
   * is marked `detached` and its ticket's run slot freed — the owner can
   * watch the leftover stream file, stop it, or start fresh.
   */
  async adopt(): Promise<void> {
    const runsDir = path.join(this.deps.root, 'runs');
    const entries = await fsp.readdir(runsDir).catch(() => [] as string[]);
    for (const id of entries) {
      const raw = await fsp.readFile(path.join(runsDir, id, 'run.json'), 'utf8').catch(() => null);
      if (raw === null) {
        continue;
      }
      try {
        const stored = JSON.parse(raw) as StoredRun;
        // The runner keeps one supervisor per provider and each adopts its
        // own runs: two adopting every record had the second detach what
        // the first had just re-attached.
        if ((stored.info.provider ?? 'opencode') !== this.deps.adapter.id) {
          continue;
        }
        const dir = path.join(runsDir, id);
        // A worker that outlived the runner is taken back when its server
        // still answers (OpenCode); a run handed over by a retiring runner
        // is otherwise resumed in place (req-51); else it is detached below.
        if (!TERMINAL.includes(stored.info.state) && stored.info.state !== 'stopping') {
          if (await this.reattach(stored, dir)) {
            continue;
          }
          if (stored.handover !== undefined && (await this.resumeInPlace(stored, stored.handover, dir))) {
            continue;
          }
        }
        // A run that is already detached stays as it is: re-detaching it on
        // every boot rewrote its record and re-stamped its ticket each time.
        if (TERMINAL.includes(stored.info.state) || stored.info.state === 'detached') {
          this.runs.set(stored.info.id, {
            info: stored.info,
            request: stored.request,
            currentRelPath: stored.request.ticketRelPath,
            currentPhase: stored.request.phase,
            dir,
            handle: null,
            startedAtMs: Date.parse(stored.info.startedAt),
            gating: false,
            audited: false,
            agentDone: false,
            telemetry: new TelemetryFold(telemetryOf(stored.info)),
          });
          continue;
        }
        const detached: RunInfo = {
          // req-67: freeze the clock at the last stamp the dead runner left.
          ...closeExecSpan(stored.info, stored.info.lastActivity),
          state: 'detached',
          endedAt: this.stamp(),
          gateFailure: 'the runner restarted while the worker lived on; watch or resume it manually',
        };
        const live: LiveRun = {
          info: detached,
          request: stored.request,
          currentRelPath: stored.request.ticketRelPath,
          currentPhase: stored.request.phase,
          dir,
          handle: null,
          startedAtMs: Date.parse(stored.info.startedAt),
          gating: false,
          audited: false,
          agentDone: false,
          telemetry: new TelemetryFold(telemetryOf(stored.info)),
        };
        this.runs.set(detached.id, live);
        await this.persist(live);
        await this.clearRunStamp(live, 'the runner restarted — the worker is detached, start fresh to resume');
      } catch {
        // a torn run.json is noise; skip the run
      }
    }
  }

  /**
   * Writes what a later runner needs to take this worker back — the server's
   * address, its per-boot credential, the process and its creation time (the
   * pid-reuse guard of a later kill). A file of the run's own, readable by the
   * owner only where the platform honours it: the credential must never ride
   * in `run.json`, which the board reads.
   */
  private async recordAttach(
    run: LiveRun,
    info: { readonly address: string; readonly password: string; readonly pid: number | null },
  ): Promise<void> {
    try {
      const pidStartedMs = info.pid === null ? null : await processStartMs(info.pid, this.exec);
      await fsp.writeFile(
        path.join(run.dir, 'attach.json'),
        JSON.stringify({ address: info.address, password: info.password, pid: info.pid, pidStartedMs }),
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch (error) {
      this.deps.log(`run ${run.info.id}: could not record the attach info — ${messageOf(error)}`);
    }
  }

  /**
   * Takes a worker that outlived its runner back: the run becomes live again
   * with a handle bound to the still-running server (a held run stays held).
   * False — nothing changes, the caller detaches — when the provider cannot
   * attach, no attach file exists, or the recorded process is gone.
   */
  private async reattach(stored: StoredRun, dir: string): Promise<boolean> {
    const adapter = this.deps.adapter;
    if (adapter.attach === undefined || stored.info.sessionRef === null) {
      return false;
    }
    const raw = await fsp.readFile(path.join(dir, 'attach.json'), 'utf8').catch(() => null);
    if (raw === null) {
      return false;
    }
    let attach: { address?: unknown; password?: unknown; pid?: unknown; pidStartedMs?: unknown };
    try {
      attach = JSON.parse(raw) as typeof attach;
    } catch {
      return false;
    }
    const pid = typeof attach.pid === 'number' ? attach.pid : null;
    if (typeof attach.address !== 'string' || typeof attach.password !== 'string' || pid === null) {
      return false;
    }
    if (!(await processAlive(pid, this.exec))) {
      return false;
    }
    const pidStartedMs = typeof attach.pidStartedMs === 'number' ? attach.pidStartedMs : undefined;
    const startedAtMs = Date.parse(stored.info.startedAt);
    const wasDetached = stored.info.state === 'detached';
    // req-67: the worker was unwatched while the runner was down — the open
    // span closes at its last stamp; the next busy report opens a new one.
    const info: RunInfo = {
      ...closeExecSpan(stored.info, stored.info.lastActivity),
      state: 'running',
      pid,
      endedAt: null,
      gateFailure: null,
    };
    const run: LiveRun = {
      info,
      request: stored.request,
      currentRelPath: stored.request.ticketRelPath,
      currentPhase: stored.request.phase,
      dir,
      handle: null,
      startedAtMs,
      gating: false,
      audited: false,
      agentDone: false,
      telemetry: new TelemetryFold(telemetryOf(stored.info)),
      ...(stored.usageBase !== undefined ? { usageBase: stored.usageBase } : {}),
    };
    this.runs.set(info.id, run);
    const handle = adapter.attach(
      {
        cwd: stored.info.worktreePath,
        instruction: stored.request.instruction,
        model: stored.request.model,
        permissionMode: stored.request.permissionMode,
        resumeRef: stored.info.sessionRef,
        ticketId: stored.request.ticketId,
        usageBase: stored.usageBase ?? ZERO_USAGE,
        onEvent: (event) => void this.onEvent(run, event),
        onSessionRef: () => undefined,
      },
      {
        address: attach.address,
        password: attach.password,
        sessionRef: stored.info.sessionRef,
        runStartedMs: startedAtMs,
        seenBeforeMs: Date.parse(stored.info.lastActivity) || 0,
        pid,
        kill: async () => {
          await killTreeGuarded(pid, this.exec, pidStartedMs);
        },
      },
    );
    run.handle = handle;
    if (stored.info.held === true) {
      handle.setHold?.(true);
    }
    void handle.exited.then((code) => void this.onWorkerExit(run, code));
    await this.persist(run);
    this.deps.log(`run ${info.id}: re-attached to its worker after the runner restarted`);
    if (wasDetached) {
      // The ticket's run stamp was cleared when the run was detached.
      await this.patchTicket(run, (text) =>
        patchTicketFile(text, {
          to: run.currentPhase,
          from: null,
          now: this.now(),
          actor: this.agentActor(),
          action: `run ${info.id} re-attached after the runner restarted`,
          run: { pid, 'started-at': stored.info.startedAt, stream: info.id },
        }),
      ).catch(() => undefined);
    }
    return true;
  }

  /**
   * A run a retiring runner handed over whose worker cannot be bound to
   * (req-51): a fresh worker resumes the provider session under the same
   * run — id, record, stream, ticket stamp — so the board and an open
   * takeover tab simply carry on. A worker still alive is killed first
   * (guarded by its recorded creation time): one worker per worktree,
   * never an unsupervised one. False — the caller detaches — without a
   * session to resume or when the spawn fails.
   */
  private async resumeInPlace(stored: StoredRun, handover: RunHandover, dir: string): Promise<boolean> {
    const sessionRef = stored.info.sessionRef;
    if (sessionRef === null) {
      return false;
    }
    if (stored.info.pid !== null && handover.pidStartedMs !== null) {
      await killTreeGuarded(stored.info.pid, this.exec, handover.pidStartedMs).catch(() => undefined);
    }
    const held = stored.info.held === true;
    // req-67: the unwatched gap does not tick — see reattach.
    const run: LiveRun = {
      info: { ...closeExecSpan(stored.info, stored.info.lastActivity), state: 'running', pid: null, endedAt: null, gateFailure: null },
      request: stored.request,
      currentRelPath: stored.request.ticketRelPath,
      currentPhase: stored.request.phase,
      dir,
      handle: null,
      startedAtMs: Date.parse(stored.info.startedAt),
      gating: false,
      audited: false,
      agentDone: false,
      telemetry: new TelemetryFold(telemetryOf(stored.info)),
      ...(stored.usageBase !== undefined ? { usageBase: stored.usageBase } : {}),
    };
    let handle: WorkerHandle;
    try {
      handle = this.deps.adapter.spawn({
        cwd: stored.info.worktreePath,
        instruction: held ? HANDOVER_HELD : HANDOVER_CONTINUE,
        model: stored.request.model,
        permissionMode: stored.request.permissionMode,
        resumeRef: sessionRef,
        ticketId: stored.request.ticketId,
        // The same run goes on: its own earlier spend stays counted.
        usageBase: stored.usageBase ?? ZERO_USAGE,
        onEvent: (event) => void this.onEvent(run, event),
        onSessionRef: (ref) => {
          run.info = { ...run.info, sessionRef: ref };
          void this.persist(run);
        },
        onAttachInfo: (info) => void this.recordAttach(run, info),
      });
    } catch (error) {
      this.deps.log(`run ${stored.info.id}: the handed-over session could not be resumed — ${messageOf(error)}`);
      return false;
    }
    this.runs.set(run.info.id, run);
    run.handle = handle;
    run.info = { ...run.info, pid: handle.pid };
    if (held) {
      handle.setHold?.(true);
    }
    void handle.exited.then((code) => void this.onWorkerExit(run, code));
    await this.persist(run);
    this.deps.log(`run ${run.info.id}: resumed in place after a runner handover`);
    await this.appendStream(run, {
      ts: this.stamp(),
      kind: 'note',
      text: 'the runner was replaced by a newer build — the session is resumed in a fresh worker',
    });
    await this.patchTicket(run, (text) =>
      patchTicketFile(text, {
        to: run.currentPhase,
        from: null,
        now: this.now(),
        actor: this.agentActor(),
        action: `run ${run.info.id} resumed after a runner handover`,
        ...(handle.pid !== null ? { run: { pid: handle.pid, 'started-at': stored.info.startedAt, stream: run.info.id } } : {}),
      }),
    ).catch(() => undefined);
    return true;
  }

  /**
   * Why this runner cannot hand over right now, or null (req-51): a run
   * in its machine gate, starting or being stopped is mid-transition —
   * the ticket move or the stop's Log line would be lost. The client
   * keeps the runner serving and asks again later.
   */
  handoverBlocker(): string | null {
    for (const run of this.runs.values()) {
      if (TERMINAL.includes(run.info.state) || run.info.state === 'detached') {
        continue;
      }
      if (run.gating) {
        return `run ${run.info.id} (${run.info.ticketId}) is in its machine gate`;
      }
      if (run.info.state === 'stopping' || run.info.state === 'starting') {
        return `run ${run.info.id} (${run.info.ticketId}) is ${run.info.state}`;
      }
    }
    return null;
  }

  /**
   * The retiring runner's half of a handover (req-51): every live run is
   * left to the successor instead of stopped. A worker the successor can
   * bind to (a recorded attach file) keeps running; any other is stopped
   * here — its pipes die with this process, and a worker nobody reads is
   * an unsupervised agent (the T-0007 review) — and its session is
   * resumed by the successor. Nothing new starts afterwards; the ticket
   * keeps its run stamp, since the run goes on.
   */
  async handOver(): Promise<number> {
    this.retiring = true;
    let count = 0;
    for (const run of [...this.runs.values()]) {
      if (run.info.state !== 'running' && run.info.state !== 'starting') {
        continue;
      }
      const attachable =
        this.deps.adapter.attach !== undefined &&
        (await fsp.stat(path.join(run.dir, 'attach.json')).then(() => true, () => false));
      const pid = run.info.pid ?? (run.handle?.pid !== undefined && run.handle.pid !== null && run.handle.pid > 0 ? run.handle.pid : null);
      const pidStartedMs = pid === null ? null : await processStartMs(pid, this.exec).catch(() => null);
      run.handover = { mode: attachable ? 'reattach' : 'resume', at: this.stamp(), pidStartedMs };
      run.info = { ...run.info, pid };
      await this.persist(run);
      if (!attachable && run.handle !== null) {
        await run.handle.stop().catch(() => undefined);
      }
      this.deps.log(`run ${run.info.id}: handed over (${run.handover.mode})`);
      count++;
    }
    return count;
  }

  list(): readonly RunInfo[] {
    return [...this.runs.values()].map((r) => r.info).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Every run with its request, newest first (the orchestrator's view). */
  records(): readonly SupervisorRecord[] {
    return [...this.runs.values()]
      .map((r) => ({ info: r.info, request: r.request }))
      .sort((a, b) => b.info.startedAt.localeCompare(a.info.startedAt));
  }

  get(runId: string): RunInfo | null {
    return this.runs.get(runId)?.info ?? null;
  }

  /** The stream file's absolute path — Drey's watch view tails it. */
  streamPath(runId: string): string | null {
    const run = this.runs.get(runId);
    return run === undefined ? null : path.join(run.dir, 'stream.jsonl');
  }

  async start(request: RunRequest, resumeRef: string | null = null, reopened = false): Promise<StartOutcome> {
    if (this.retiring) {
      return { ok: false, error: 'the runner is handing over to a newer build — try again in a moment' };
    }
    const live = this.list().find(
      (r) => r.ticketId === request.ticketId && !TERMINAL.includes(r.state) && r.state !== 'detached',
    );
    if (live !== undefined) {
      return { ok: false, error: `${request.ticketId} already has a live run (${live.id}) — stop it first` };
    }
    // A reopened session belongs to a ticket that may have moved on since.
    const failures = reopened ? [] : this.validate(request);
    if (failures.length > 0) {
      return { ok: false, error: failures.join(' ') };
    }

    const id = `R-${this.stamp().replaceAll(/[-:.]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(this.deps.root, 'runs', id);
    // The home rule's path (ADR-0080), computed in `composeRunRequest` and
    // carried on the request — the runner never derives paths.
    const worktreePath = request.worktreePath;

    let prepared: PreparedWorktree;
    try {
      await fsp.mkdir(dir, { recursive: true });
      prepared = await this.prepareWorktree(request, worktreePath);
    } catch (error) {
      return { ok: false, error: `worktree failed: ${messageOf(error)}` };
    }

    // T-0049: the handover resolution. Only the supervisor holds every
    // record (boot-adopted terminal ones included), and only the
    // preparation above tells whether the worktree invalidated prior
    // sessions — so this is the one place the rules run. The pre-T-0049
    // explicit-session paths (reattach, resumeInPlace, reopen, a detached
    // run's resume) pass their own session and skip resolution entirely.
    let decision: HandoverDecision | null = null;
    if (resumeRef === null && !reopened && request.handover !== undefined) {
      const candidate = this.handoverCandidate(request);
      decision = resolveHandover({
        requested: request.handover,
        phase: request.phase,
        candidate,
        provider: this.deps.adapter.id,
        model: request.model,
        sessionInvalidated: prepared.sessionInvalidated,
        sessionInUse: this.sessionInUse(candidate?.sessionRef ?? null),
        capability: COMPACT_CAPABILITY[this.deps.adapter.id],
        config: this.handoverConfig,
        nowMs: this.now().getTime(),
      });
      resumeRef = decision.resumeRef;
      this.deps.log(`run ${id} (${request.ticketId}): handover ${decision.mode} — ${decision.why}`);
    }

    const info: RunInfo = {
      id,
      ticketId: request.ticketId,
      provider: request.provider,
      state: 'starting',
      pid: null,
      startedAt: this.stamp(),
      endedAt: null,
      sessionRef: resumeRef,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      lastActivity: this.stamp(),
      activity: '',
      contextTokens: null,
      column: request.column ?? request.phase,
      steerCount: 0,
      lastSteerRung: null,
      worktreePath,
      branch: request.branch,
      worktree: prepared.outcome,
      gateResult: null,
      model: request.model,
      phase: request.phase,
      usage: { input: null, cacheRead: null, cacheCreation: null, output: null },
      lastTurnContext: null,
      turns: 0,
      readCalls: 0,
      tokensBeforeFirstWrite: null,
      handoverMode: decision?.mode ?? 'fresh',
      // The candidate's session, never the init event — a forked id
      // would lose the lineage (T-0049).
      resumedFrom: decision !== null && decision.mode !== 'fresh' ? decision.resumeRef : null,
      gateFailure: null,
    };
    const run: LiveRun = {
      info,
      request,
      currentRelPath: request.ticketRelPath,
      currentPhase: request.phase,
      dir,
      handle: null,
      startedAtMs: this.now().getTime(),
      gating: false,
      audited: false,
      agentDone: false,
      telemetry: new TelemetryFold(),
      ...(reopened ? { reopened: true } : {}),
    };
    this.runs.set(id, run);
    const openNote = (text: string): string => `${JSON.stringify({ ts: this.stamp(), kind: 'note', text })}\n`;
    await fsp.writeFile(
      path.join(dir, 'stream.jsonl'),
      openNote(`run ${id} for ${request.ticketId} on ${request.branch} — worktree ${prepared.outcome}`) +
        (prepared.outcome === 'moved-aside'
          ? openNote(
              `stale dirty worktree moved aside to ${prepared.movedTo} — kept, not deleted; earlier session context is invalid`,
            )
          : '') +
        (prepared.links !== undefined ? openNote(linkNote(prepared.links)) : '') +
        (decision !== null ? openNote(`handover: ${decision.mode} — ${decision.why}`) : ''),
      'utf8',
    );

    const handle = this.spawnWorker(run, {
      resumeRef,
      ...(decision?.compactFirst === true ? { compactFirst: true } : {}),
      // A resume the adapter cannot establish respawns fresh under the
      // same run id (T-0049) — only the resolution path asks for that.
      ...(decision !== null && resumeRef !== null
        ? { onResumeFailed: (reason: string) => void this.freshFallback(run, reason) }
        : {}),
    });
    run.info = { ...run.info, state: 'running', pid: handle.pid };
    // req-65: an interactive dialog is the owner's from turn one — held
    // at spawn (the worker stands after its first, interviewing turn),
    // and at its end neither the gate nor a move runs: the owner moves
    // the ticket themselves. The `run:` stamp below is still laid.
    const interactive = request.interactive;
    if (interactive !== undefined) {
      handle.setHold?.(true);
      run.info = { ...run.info, held: true, interactive };
    }
    if (reopened) {
      handle.setHold?.(true);
      run.info = { ...run.info, held: true };
      await this.persist(run);
      await this.logLine(run, 'session reopened by the owner — the worker stands until you prompt it');
      return { ok: true, run: run.info };
    }
    await this.persist(run);
    if (interactive !== undefined) {
      await this.logLine(
        run,
        `interactive dialog (${interactive}) — the worker is yours from the first turn; the run never gates or moves`,
      );
    }

    // The ticket carries the live run (schema `run` map) — the board and
    // any fleet surface can see at most one live run per ticket.
    await this.patchTicket(run, (text) =>
      patchTicketFile(text, {
        to: request.phase,
        from: null,
        now: this.now(),
        actor: this.agentActor(),
        action: `run ${id} started (${request.provider}${request.model !== null ? `, ${request.model}` : ''}) — worktree ${prepared.outcome}${decision !== null ? `, handover ${decision.mode}` : ''}`,
        ...(request.recordWorker !== undefined && request.recordWorker !== '' ? { setWorker: request.recordWorker } : {}),
        ...(interactive !== undefined ? { setInteractive: true } : {}),
        ...(handle.pid !== null
          ? { run: { pid: handle.pid, 'started-at': this.stamp(), stream: id } }
          : {}),
      }),
    );

    return { ok: true, run: run.info };
  }

  /**
   * Spawns the run's worker and wires its events — the one spawn path
   * for the first worker and the fresh fallback's replacement alike
   * (T-0049). The handle the run currently owns decides its exit; a
   * worker a fallback replaced decides nothing.
   */
  private spawnWorker(
    run: LiveRun,
    resume: {
      readonly resumeRef: string | null;
      readonly compactFirst?: boolean;
      readonly onResumeFailed?: (reason: string) => void;
    },
  ): WorkerHandle {
    const request = run.request;
    const handle = this.deps.adapter.spawn({
      cwd: run.info.worktreePath,
      instruction: request.instruction,
      model: request.model,
      permissionMode: request.permissionMode,
      resumeRef: resume.resumeRef,
      ...(resume.compactFirst === true ? { compactFirst: true } : {}),
      ticketId: request.ticketId,
      onEvent: (event) => void this.onEvent(run, event),
      onSessionRef: (ref) => {
        run.info = { ...run.info, sessionRef: ref };
        void this.persist(run);
      },
      onAttachInfo: (info) => void this.recordAttach(run, info),
      onUsageBase: (base) => {
        run.usageBase = base;
        void this.persist(run);
      },
      ...(resume.onResumeFailed !== undefined ? { onResumeFailed: resume.onResumeFailed } : {}),
    });
    run.handle = handle;
    void handle.exited.then((code) => {
      if (run.handle === handle) {
        void this.onWorkerExit(run, code);
      }
    });
    return handle;
  }

  /**
   * The newest terminal record of this ticket and model in this
   * supervisor (T-0049): its provider is the supervisor's own (adopt
   * filters by it), `detached` never qualifies — its worker may still
   * live — and the resolution judges phase, session and staleness.
   */
  private handoverCandidate(request: RunRequest): HandoverCandidate | null {
    const newest = [...this.runs.values()]
      .filter(
        (r) =>
          r.request.ticketId === request.ticketId &&
          (r.info.model ?? r.request.model) === request.model &&
          HANDOVER_CANDIDATE_STATES.includes(r.info.state),
      )
      .sort((a, b) => b.info.startedAt.localeCompare(a.info.startedAt))[0];
    if (newest === undefined) {
      return null;
    }
    return {
      phase: newest.info.phase ?? newest.request.phase,
      provider: newest.info.provider,
      model: newest.info.model ?? null,
      state: newest.info.state,
      sessionRef: newest.info.sessionRef,
      lastTurnContext: newest.info.lastTurnContext ?? null,
      endedAt: newest.info.endedAt,
    };
  }

  /** Whether any non-terminal run of this supervisor holds the session
   *  (T-0049) — a detached one counts, its worker may still live. */
  private sessionInUse(sessionRef: string | null): boolean {
    if (sessionRef === null) {
      return false;
    }
    return [...this.runs.values()].some(
      (r) => !TERMINAL.includes(r.info.state) && r.info.sessionRef === sessionRef,
    );
  }

  /**
   * The resume the adapter reported unestablishable (T-0049): the dying
   * worker is stopped and a FRESH one takes the run over — same id,
   * record, stream, ticket stamp and instruction — so a broken session
   * never fails the run. A failure after a successful resume never lands
   * here (the adapters report only before their first prompt).
   */
  private async freshFallback(run: LiveRun, reason: string): Promise<void> {
    if (run.fallbackActive === true || TERMINAL.includes(run.info.state) || run.handle === null) {
      return;
    }
    run.fallbackActive = true;
    this.deps.log(`run ${run.info.id}: the resume failed — ${reason}; starting fresh under the same run id`);
    await run.handle.stop().catch(() => undefined);
    run.handle = null;
    run.info = {
      ...run.info,
      state: 'starting',
      pid: null,
      handoverMode: 'fresh',
      resumedFrom: null,
      sessionRef: null,
    };
    const handle = this.spawnWorker(run, { resumeRef: null });
    run.fallbackActive = false;
    run.info = { ...run.info, state: 'running', pid: handle.pid };
    await this.appendStream(run, {
      ts: this.stamp(),
      kind: 'note',
      text: `the resume failed (${reason}) — the run starts fresh with the same instruction`,
    });
    await this.persist(run);
  }

  async stop(runId: string, reason: string | null): Promise<StopOutcome> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return { ok: false, error: `unknown run "${runId}"` };
    }
    if (TERMINAL.includes(run.info.state)) {
      return { ok: false, error: `run ${runId} already ended (${run.info.state})` };
    }
    if (run.handover !== undefined) {
      // Its successor owns it now; a stop here would be undone by the resume.
      return { ok: false, error: 'the runner is handing over to a newer build — try again in a moment' };
    }
    // A detached run has no attached worker: stopping it kills the recorded
    // process if it still lives and ends the record — the only way to free
    // the ticket it blocks.
    run.info = { ...run.info, state: 'stopping' };
    // The worker dies FIRST and the Log line follows with the run's end: the
    // line used to be written before the kill (a ticket write plus a git
    // commit), and a runner shutdown that gave up waiting on it exited with
    // the worker still alive — the orphans.
    run.stopNote = `stopped by the owner${reason !== null ? ` — ${reason}` : ''}`;
    if (run.handle !== null) {
      await run.handle.stop();
      // onWorkerExit sees 'stopping' and finishes the run.
    } else {
      // No attached worker (a boot-adopted leftover): the guarded kill
      // by recorded PID, then finish here.
      if (run.info.pid !== null) {
        await killTreeGuarded(run.info.pid, this.exec, run.startedAtMs);
      }
      await this.finish(run, 'stopped');
    }
    return { ok: true };
  }

  async send(runId: string, text: string): Promise<StopOutcome & { rung?: SteerRung }> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return { ok: false, error: `unknown run "${runId}"` };
    }
    if (run.info.state !== 'running' && run.info.state !== 'starting') {
      return { ok: false, error: `run ${runId} is ${run.info.state} — nothing to steer` };
    }
    if (run.handle === null) {
      return { ok: false, error: `run ${runId} has no worker attached to steer` };
    }
    // The first prompt of the owner takes the run over: until then the
    // runner drives as usual (the tab only watches), from here on the
    // worker's finished turn no longer ends the run. An answer to the
    // worker's own question is not a takeover (req-64): the worker goes
    // on with its step and its next finished turn ends the run as usual.
    const answersQuestion = run.info.waiting?.kind === 'question';
    const form = run.info.waiting?.questions;
    if (answersQuestion && form !== undefined && run.handle.answerQuestion !== undefined) {
      // A question the worker asked with its `question` tool: the typed
      // text is the form's answer — the blocked tool call returns it.
      return this.answerQuestion(runId, answersFromText(form, text));
    }
    if (!answersQuestion) {
      await this.holdForOwner(run, 'first prompt');
    }
    // The owner's prompt belongs in the run's transcript, whatever its rung.
    await this.appendStream(run, { ts: this.stamp(), kind: 'note', text: `you › ${text}` });
    const rung = await run.handle.steer(text);
    run.info = { ...run.info, steerCount: run.info.steerCount + 1, lastSteerRung: rung };
    await this.persist(run);
    await this.logLine(run, `${answersQuestion ? 'answered by the owner' : `steer (${rung})`}: ${text.slice(0, 200)}`);
    if (rung === 'refused') {
      return { ok: false, error: `the ${run.info.provider} worker took no message — it may have ended` };
    }
    return { ok: true, rung };
  }

  /**
   * The owner takes a live run over: the worker's session stays up past a
   * finished turn until it is handed back (`release`), and the run is
   * marked `held` so every surface can show who drives. Only providers
   * whose handle can hold take part.
   */
  async takeover(runId: string): Promise<TakeoverOutcome> {
    const run = this.liveRunWithHold(runId);
    if (typeof run === 'string') {
      return { ok: false, error: run };
    }
    run.handle!.setHold!(true);
    run.info = { ...run.info, held: true };
    await this.persist(run);
    await this.logLine(run, 'taken over by the owner');
    return { ok: true };
  }

  /**
   * Takes the run over implicitly when the owner first acts on it (a
   * prompt, an interrupt): a worker that can hold is held, once. A worker
   * that cannot (Claude Code) is left as it is — the caller carries on.
   */
  private async holdForOwner(run: LiveRun, why: string): Promise<void> {
    if (run.info.held === true || run.handle === null || run.handle.setHold === undefined) {
      return;
    }
    run.handle.setHold(true);
    run.info = { ...run.info, held: true };
    await this.persist(run);
    await this.logLine(run, `taken over by the owner (${why})`);
  }

  /**
   * Brings a detached run back: its worker could not be re-attached (the
   * process is gone, or the provider cannot), but the provider's session
   * still exists. The detached record ends as stopped and a fresh worker
   * resumes that session under a new run of the same request — the
   * owner's "make it attached again".
   */
  async resume(runId: string): Promise<StartOutcome> {
    const old = this.runs.get(runId);
    if (old === undefined) {
      return { ok: false, error: `unknown run "${runId}"` };
    }
    if (TERMINAL.includes(old.info.state)) {
      return this.reopen(old);
    }
    if (old.info.state !== 'detached') {
      return { ok: false, error: `run ${runId} is ${old.info.state} — only a detached or ended run is resumed` };
    }
    if (old.info.sessionRef === null) {
      return { ok: false, error: `run ${runId} never reported a session — nothing to resume (start the ticket fresh)` };
    }
    const sessionRef = old.info.sessionRef;
    old.stopNote = 'resumed in a new run';
    if (old.info.pid !== null) {
      await killTreeGuarded(old.info.pid, this.exec, old.startedAtMs);
    }
    await this.finish(old, 'stopped');
    // The stored request's handover ask is stripped (T-0049): this start
    // carries its own session explicitly, and a stored 'auto' must not
    // double-resolve against the record being replaced.
    const { handover: _storedAsk, ...restored } = old.request;
    return this.start(
      {
        ...restored,
        instruction:
          'The runner restarted and this session was resumed. Continue the step where you left off; ' +
          'your original brief is earlier in this conversation. Do not search the disk for files already named in it.',
      },
      sessionRef,
    );
  }

  /**
   * An ended run's provider session, picked up again under a new run the
   * owner holds: the worker answers the opening line and stands, waiting
   * for the takeover tab's prompts. The ticket is left alone — no stamp,
   * no gate, no move — because it may have gone on since.
   */
  private async reopen(old: LiveRun): Promise<StartOutcome> {
    if (old.info.sessionRef === null) {
      return { ok: false, error: `run ${old.info.id} never reported a session — nothing to resume` };
    }
    if (old.info.provider !== this.deps.adapter.id) {
      return { ok: false, error: `run ${old.info.id} was a ${old.info.provider} run — the runner's worker is ${this.deps.adapter.id}` };
    }
    return this.start(
      {
        ...old.request,
        instruction:
          'The owner has reopened this session to talk to you. Reply with one short line that you are ready, then wait for their instructions.',
      },
      old.info.sessionRef,
      true,
    );
  }

  /**
   * Stores a file the owner attaches in the takeover tab inside the run's
   * worktree (`.drey-attachments/`, kept out of git through the checkout's
   * exclude file) and returns its absolute path — the prompt then names
   * the path, which both workers can read.
   */
  async attachFile(
    runId: string,
    name: string,
    dataBase64: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return { ok: false, error: `unknown run "${runId}"` };
    }
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: `an attachment is 1 byte to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB` };
    }
    const worktree = run.info.worktreePath;
    const dir = path.join(worktree, ATTACHMENT_DIR);
    const safe = name.replace(/[^\w.\- ]/g, '_').slice(-80) || 'file';
    const target = path.join(dir, `${this.now().getTime()}-${safe}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(target, bytes);
      const excludeRel = (await this.git.run(worktree, ['rev-parse', '--git-path', 'info/exclude'])).trim();
      const exclude = path.resolve(worktree, excludeRel);
      const current = await fsp.readFile(exclude, 'utf8').catch(() => '');
      if (!current.split('\n').some((line) => line.trim() === `${ATTACHMENT_DIR}/`)) {
        await fsp.mkdir(path.dirname(exclude), { recursive: true });
        const lead = current === '' || current.endsWith('\n') ? '' : '\n';
        await fsp.writeFile(exclude, `${current}${lead}${ATTACHMENT_DIR}/\n`, 'utf8');
      }
    } catch (error) {
      return { ok: false, error: `the attachment could not be stored: ${messageOf(error)}` };
    }
    return { ok: true, path: target };
  }

  /** The soft stop of the held run's current turn (the session stays). */
  async interrupt(runId: string): Promise<TakeoverOutcome> {
    const run = this.liveRunWithHold(runId);
    if (typeof run === 'string') {
      return { ok: false, error: run };
    }
    await this.holdForOwner(run, 'interrupt');
    const done = (await run.handle!.interrupt?.()) ?? false;
    if (!done) {
      return { ok: false, error: `the ${run.info.provider} worker took no interrupt — it may be idle already` };
    }
    await this.logLine(run, 'turn interrupted by the owner — the session is kept');
    return { ok: true };
  }

  /**
   * Hands a held run back to the runner. A worker that is idle by now has
   * finished its turn, so the run ends and the machine gate decides, as
   * after any finished turn; a busy worker simply carries on.
   */
  async release(runId: string): Promise<TakeoverOutcome> {
    const run = this.liveRunWithHold(runId);
    if (typeof run === 'string') {
      return { ok: false, error: run };
    }
    run.handle!.setHold!(false);
    run.info = { ...run.info, held: false };
    await this.persist(run);
    await this.logLine(run, 'handed back to the runner');
    return { ok: true };
  }

  /** The live run with a hold-capable worker, or the reason there is none. */
  private liveRunWithHold(runId: string): LiveRun | string {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return `unknown run "${runId}"`;
    }
    if (run.info.state !== 'running' && run.info.state !== 'starting') {
      return `run ${runId} is ${run.info.state} — nothing to take over`;
    }
    if (run.handle === null || run.handle.setHold === undefined) {
      return `the ${run.info.provider} worker cannot be taken over`;
    }
    return run;
  }

  /** True while at least one run is starting/running — the idle shutdown waits on this. */
  hasLive(): boolean {
    return this.list().some((r) => !TERMINAL.includes(r.state) && r.state !== 'detached');
  }

  /** Whether a live run (starting/running/stopping, or a detached one —
   *  unwatchable, treat as busy) is working in this worktree: the
   *  prepare-time branch-conflict healing (T-0044) never removes a tree
   *  a live run holds. */
  private isWorktreeLive(worktreePath: string): boolean {
    const needle = normalizeForMatch(worktreePath);
    return this.list().some(
      (r) => !TERMINAL.includes(r.state) && normalizeForMatch(r.worktreePath) === needle,
    );
  }

  // -------------------------------------------------------------------------

  /** The rules the runner enforces itself (ADR-0076: the validator runs where the data is). */
  private validate(request: RunRequest): readonly string[] {
    const failures: string[] = [];
    if (!/^T-\d{4,}$/.test(request.ticketId)) {
      failures.push(`"${request.ticketId}" is not a ticket id`);
    }
    // Prefix-aware (T-0041): `tickets/30-plan/…` and `tickets/plan/…` both
    // match the phase `plan` — the stripped id is the identity.
    const parts = ticketPathParts(request.ticketRelPath);
    if (parts === null || parts.phase !== request.phase || parts.stem !== request.ticketId) {
      failures.push(`the ticket path does not match id and phase (${request.ticketRelPath})`);
    }
    if (request.instruction.trim() === '') {
      failures.push('the instruction is empty');
    }
    if (request.branch !== `t/${request.ticketId}`) {
      failures.push(`the branch is not the deterministic t/${request.ticketId}`);
    }
    if (request.worktreePath.trim() === '') {
      failures.push('the worktree path is empty (a pre-T-0044 sender derived it itself)');
    }
    // An interactive dialog needs no gate commands — the run never gates
    // (req-65): the interview itself is the deliverable, the owner moves
    // the ticket when the dialog ends.
    if (request.acceptance.length === 0 && request.gate !== 'structural' && request.interactive === undefined) {
      failures.push('the ticket has no acceptance criteria — the machine gate would have nothing to run');
    }
    return failures;
  }

  private async onEvent(run: LiveRun, event: NormalizedEvent): Promise<void> {
    // Set in the synchronous prefix: the worker's exit can race the event
    // delivery, and `agentDone` must already be true when the exit decides.
    if (event.kind === 'result') {
      run.agentDone = true;
    }
    run.telemetry.apply(event);
    await this.appendStream(run, event);
    const telemetry = run.telemetry.get();
    let next: RunInfo = {
      ...run.info,
      lastActivity: event.ts,
      ...(event.activity !== undefined && event.activity !== '' ? { activity: event.activity } : {}),
      ...(event.contextTokens !== undefined ? { contextTokens: event.contextTokens } : {}),
      ...(event.contextWindow !== undefined ? { contextWindow: event.contextWindow } : {}),
      ...(event.turn !== undefined ? { turn: event.turn } : {}),
      ...(event.commands !== undefined ? { commands: event.commands } : {}),
      ...(event.tokensIn !== undefined ? { tokensIn: event.tokensIn } : {}),
      ...(event.tokensOut !== undefined ? { tokensOut: event.tokensOut } : {}),
      ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
      ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
      ...(event.waiting !== undefined ? { waiting: event.waiting === null ? null : { ...event.waiting, since: event.ts } } : {}),
      usage: telemetry.usage,
      lastTurnContext: telemetry.lastTurnContext,
      turns: telemetry.turns,
      readCalls: telemetry.readCalls,
      tokensBeforeFirstWrite: telemetry.tokensBeforeFirstWrite,
      ...(event.kind === 'error' ? { lastError: event.text ?? 'error' } : {}),
    };
    // req-67: fold the elapsed clock's busy spans — a flip closes or opens
    // one at this event's stamp, so waits and standing do not tick.
    const was = isExecuting(run.info);
    const busy = isExecuting(next);
    if (busy) {
      if (!was) {
        // The turn (re)started: a new span opens here.
        next = { ...next, execSince: event.ts };
      } else if (run.info.execSince === undefined) {
        // A record adopted mid-busy with no tracking yet: presumed working since the start.
        next = { ...next, execSince: next.startedAt };
      } else if (run.info.execSince === null) {
        // Re-attached mid-busy after the restart closed the old span: resume here.
        next = { ...next, execSince: event.ts };
      }
    } else if (was) {
      const from = run.info.execSince === undefined ? run.info.startedAt : run.info.execSince;
      next = closeExecSpan({ ...next, execSince: from }, event.ts);
    }
    run.info = next;
    if (event.kind === 'error') {
      this.deps.log(`run ${run.info.id}: ${event.text ?? 'error'}`);
    }
    await this.persist(run);
    if (event.waiting !== undefined && event.waiting !== null) {
      // The ticket's Log keeps the question — the owner may answer from the board later.
      const what = event.waiting.kind === 'question' ? 'asks the owner' : 'waits for approval';
      this.deps.log(`run ${run.info.id} (${run.info.ticketId}) ${what}: ${event.waiting.text.slice(0, 200)}`);
      await this.logLine(run, `${what} — ${event.waiting.text.slice(0, 400)}`);
    }
  }

  /**
   * The owner's answer to the worker's pending permission request
   * (req-64): `once`, `always` or `reject`, passed to the provider.
   */
  async answerPermission(runId: string, decision: PermissionDecision): Promise<TakeoverOutcome> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return { ok: false, error: `unknown run "${runId}"` };
    }
    const waiting = run.info.waiting ?? null;
    if (waiting === null || waiting.kind !== 'permission' || waiting.requestId === undefined) {
      return { ok: false, error: `run ${runId} waits for no approval` };
    }
    if (run.handle === null || run.handle.answerPermission === undefined) {
      return { ok: false, error: `the ${run.info.provider} worker takes no approvals` };
    }
    if (!(await run.handle.answerPermission(waiting.requestId, decision))) {
      return { ok: false, error: 'the worker took no answer — the request may be gone' };
    }
    await this.logLine(run, `${decision === 'reject' ? 'rejected' : decision === 'always' ? 'approved always' : 'approved once'} by the owner — ${waiting.text.slice(0, 200)}`);
    return { ok: true };
  }

  /**
   * The owner's answer to the worker's pending question form (OpenCode's
   * `question` tool): per question a choice or the owner's own words. Not
   * a takeover — the worker goes on with its step.
   */
  async answerQuestion(runId: string, answers: QuestionAnswers): Promise<StopOutcome & { rung?: SteerRung }> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return { ok: false, error: `unknown run "${runId}"` };
    }
    const waiting = run.info.waiting ?? null;
    if (waiting === null || waiting.questions === undefined || waiting.requestId === undefined) {
      return { ok: false, error: `run ${runId} asks no question` };
    }
    if (run.handle === null || run.handle.answerQuestion === undefined) {
      return { ok: false, error: `the ${run.info.provider} worker takes no answers` };
    }
    const said = answersText(waiting.questions, answers);
    if (Object.keys(answers).length === 0) {
      return { ok: false, error: 'the answer is empty' };
    }
    if (!(await run.handle.answerQuestion(waiting.requestId, answers))) {
      return { ok: false, error: 'the worker took no answer — the question may be gone' };
    }
    await this.appendStream(run, { ts: this.stamp(), kind: 'note', text: `you › ${said}` });
    await this.logLine(run, `answered by the owner: ${said.slice(0, 200)}`);
    return { ok: true, rung: 'inject' };
  }

  /**
   * The lease reaper (M85): a run whose worker process is provably dead
   * but whose record still holds the ticket — a lost exit event, a
   * spawn that never came up. The run is failed and logged, the
   * ticket's slot freed. A silent-but-alive worker is never touched: a
   * local model may think for minutes (ADR-0014).
   */
  async reap(): Promise<void> {
    for (const run of [...this.runs.values()]) {
      const state = run.info.state;
      if (TERMINAL.includes(state) || state === 'detached' || state === 'stopping' || run.gating || run.handover !== undefined) {
        continue;
      }
      // The opencode handle reports its pid only once the server has
      // booted — re-read it before judging "never started" (T-0007
      // review: the reaper killed runs whose agents were mid-flight).
      const handlePid = run.handle?.pid ?? null;
      const pid = run.info.pid ?? (handlePid !== null && handlePid > 0 ? handlePid : null);
      if (pid !== null && pid !== run.info.pid) {
        run.info = { ...run.info, pid };
        await this.persist(run);
      }
      if (pid === null) {
        // A spawn that never produced a worker: lost after two silent
        // minutes. Fresh activity (usage/text events) means a worker is
        // alive even without a recorded pid — never reap it (ADR-0014).
        if (run.info.held !== true && this.stale(run)) {
          run.info = { ...run.info, gateFailure: 'lease lost — the worker never started; reaped' };
          await this.logLine(run, 'lease reaper: the worker never started — run reaped, ticket freed');
          if (run.handle !== null) {
            await run.handle.stop().catch(() => undefined);
          }
          await this.finish(run, 'failed');
        }
        continue;
      }
      if (!(await processAlive(pid, this.exec))) {
        run.info = { ...run.info, gateFailure: 'lease lost — the worker process is gone; reaped' };
        await this.logLine(run, 'lease reaper: the worker process is gone — run reaped, ticket freed');
        if (run.handle !== null) {
          await run.handle.stop().catch(() => undefined);
        }
        await this.finish(run, 'failed');
      }
    }
  }

  /** The run's last sign of life is older than two minutes. */
  private stale(run: LiveRun): boolean {
    const last = Math.max(run.startedAtMs, Date.parse(run.info.lastActivity) || 0);
    return this.now().getTime() - last > 2 * 60_000;
  }

  /**
   * The machine gate: the ticket's acceptance commands, in order, in the
   * worktree. A structural run (the plan phase) instead reads what the
   * run produced — writing the executable criteria IS the plan's
   * deliverable, so the gate checks they came into existence.
   */
  private async runGate(run: LiveRun): Promise<string | null> {
    if (run.request.gate === 'structural') {
      const text = await fsp
        .readFile(path.join(run.request.ticketsVaultPath, run.currentRelPath), 'utf8')
        .catch(() => null);
      if (text === null) {
        return 'the ticket file disappeared — nothing to gate';
      }
      if (acceptanceCommands(text).length === 0) {
        return 'the run produced no executable acceptance criteria — a plan must end with at least one `- [ ] `command`` line';
      }
      return null;
    }
    for (const command of run.request.acceptance) {
      await this.logLine(run, `gate: ${command}`);
      try {
        await (this.deps.execShell ?? execShell)(command, run.info.worktreePath);
      } catch (error) {
        // The full output is bounded by SANITY_CAP so run.json stays sane;
        // the configurable 40/4096 tail applies when it is injected into a
        // retry's instruction, and the Log line takes only the first line.
        const capped = capTail(combinedOutput(error), SANITY_CAP);
        return `\`${command}\` failed\n\n${capped.text}`;
      }
    }
    return null;
  }

  private async onWorkerExit(run: LiveRun, code: number | null): Promise<void> {
    if (TERMINAL.includes(run.info.state)) {
      return; // the lease reaper got here first
    }
    if (run.handover !== undefined) {
      return; // handed over: the successor decides how this run goes on
    }
    if (run.fallbackActive === true) {
      return; // a failed resume being replaced (T-0049): the replacement decides
    }
    if (run.info.state === 'stopping') {
      await this.finish(run, 'stopped');
      return;
    }
    if (run.info.state === 'detached') {
      return;
    }
    // An interactive dialog (req-65) never gates and never moves: its
    // deliverable is the conversation, and the owner moves the ticket
    // themselves when it ends — however the worker's process came to an end.
    if (run.request.interactive !== undefined) {
      await this.logLine(run, `interactive dialog ended (exit ${code ?? 'signal'}) — the owner moves the ticket`);
      await this.finish(run, 'done');
      return;
    }
    // Agent-decided completion (ADR-0077): the gate is the safety net for
    // the agent's claimed-done work. A worker that ends without a result —
    // a spawn that never came up, a crash — has claimed nothing, so the
    // step fails red no matter how trivial the gate would be.
    if (!run.agentDone) {
      await this.logLine(
        run,
        `worker ended without finishing its turn (exit ${code ?? 'signal'}) — no agent-done, the step fails`,
      );
      await this.finish(run, 'failed');
      return;
    }
    if (run.reopened === true) {
      await this.logLine(run, `reopened session ended (exit ${code ?? 'signal'})`);
      await this.finish(run, 'done');
      return;
    }
    run.gating = true;
    const failure = await this.runGate(run);
    if (failure !== null) {
      run.info = { ...run.info, gateFailure: failure, gateResult: 'red' };
      await this.logLine(run, `machine gate failed — ${shortGateLine(failure)}`);
      await this.finish(run, 'failed');
      return;
    }
    run.info = { ...run.info, gateResult: 'green' };
    // The quality rungs (M85): a green gate may hand the step to a
    // second worker before it moves — the sampling audit or the
    // semantic gate's review. One round only; its own gate decides.
    if (!run.audited && this.deps.secondOpinion !== undefined) {
      const brief = await this.deps.secondOpinion(run.request).catch(() => null);
      if (brief !== null && run.handle !== null) {
        run.audited = true;
        const worktree = run.info.worktreePath;
        const resumeRef = run.info.sessionRef;
        const handle = this.deps.adapter.spawn({
          cwd: worktree,
          instruction: brief,
          model: run.request.model,
          permissionMode: run.request.permissionMode,
          resumeRef: null,
          ticketId: run.request.ticketId,
          onEvent: (event) => void this.onEvent(run, event),
          onSessionRef: (ref) => {
            run.info = { ...run.info, sessionRef: ref };
            void this.persist(run);
          },
        });
        run.handle = handle;
        run.gating = false;
        run.info = { ...run.info, state: 'running', pid: handle.pid };
        await this.logLine(run, 'second opinion — a fresh worker reviews the step before it moves');
        await this.persist(run);
        void handle.exited.then((code) => void this.onWorkerExit(run, code));
        return;
      }
    }
    if (run.request.nextPhase !== null) {
      const moved = await this.moveTicketOnSuccess(run, run.request.nextPhase);
      if (!moved.ok) {
        await this.logLine(run, `the gate passed but the move failed — ${moved.error}`);
        await this.finish(run, 'failed');
        return;
      }
    }
    await this.logLine(run, `run finished (exit ${code ?? 'signal'})`);
    await this.finish(run, 'done');
  }

  /** The success transition: move + entered-stamp + one commit (board semantics). */
  private async moveTicketOnSuccess(run: LiveRun, nextPhase: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const request = run.request;
    const oldRel = run.currentRelPath;
    // The resolved (numbered) target directory (T-0041); records stored
    // before it carry no nextPhaseDir — the bare phase id is the fallback.
    const nextDir = request.nextPhaseDir ?? nextPhase;
    const newRel = `tickets/${nextDir}/${request.ticketId}.md`;
    try {
      const abs = (rel: string): string => path.join(request.ticketsVaultPath, rel);
      const text = await fsp.readFile(abs(oldRel), 'utf8');
      // A claim-flagged next phase stamps the fleet's identity; otherwise
      // the move releases a stale claim — a claim must never ride along
      // into a column whose pool it would block (review finding 3).
      const claims =
        request.claimIdentity !== null ? { claimBy: request.claimIdentity } : { releaseClaim: true };
      const patched = patchTicketFile(text, {
        to: nextPhase,
        from: run.currentPhase,
        now: this.now(),
        actor: this.agentActor(),
        action: `run ${run.info.id} done — gate green, moving to ${nextPhase}`,
        ...claims,
      });
      await fsp.mkdir(path.dirname(abs(newRel)), { recursive: true });
      await fsp.rename(abs(oldRel), abs(newRel));
      await fsp.writeFile(abs(newRel), patched, 'utf8');
      await this.dropPin(request.ticketsVaultPath, request.ticketId);
      const location = await this.git.locate(request.ticketsVaultPath);
      if (location !== null) {
        const repoRel = [oldRel, newRel].map((p) => `${location.prefix}${p}`);
        await this.git.commitPaths(
          location.root,
          repoRel,
          `tickets: ${request.ticketId} ${run.currentPhase} -> ${nextPhase} (fleet)`,
        );
        // The optional auto-push (T-0041): a failed push is a log line,
        // never a failed transition — the commit is already durable.
        if (request.pushRemote !== null) {
          try {
            await this.git.push(location.root, request.pushRemote);
          } catch (error) {
            this.deps.log(`push of the transition to "${request.pushRemote}" failed — ${messageOf(error)}`);
          }
        }
      }
      run.currentRelPath = newRel;
      run.currentPhase = nextPhase;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  /** The moved id leaves every pin section (the board's own rule). */
  private async dropPin(vaultPath: string, ticketId: string): Promise<void> {
    const orderPath = path.join(vaultPath, 'tickets/_meta/order.md');
    const orderText = await fsp.readFile(orderPath, 'utf8').catch(() => null);
    if (orderText === null) {
      return;
    }
    const { pins } = parseOrderFile(orderText);
    let touched = false;
    let text = orderText;
    for (const [section, ids] of Object.entries(pins)) {
      const kept = ids.filter((x) => x !== ticketId);
      if (kept.length !== ids.length) {
        touched = true;
        text = rewriteOrderSection(text, section, kept);
      }
    }
    if (touched) {
      await fsp.writeFile(orderPath, text, 'utf8');
    }
  }

  private async finish(run: LiveRun, state: RunState): Promise<void> {
    const stamp = this.stamp();
    // req-67: the clock freezes at the run's end — a busy state the provider
    // never reported counts from the run's start, an open span from its stamp.
    const last = run.info;
    const open = isExecuting(last) && last.execSince === undefined ? { ...last, execSince: last.startedAt } : last;
    run.info = {
      ...closeExecSpan(open, stamp),
      state,
      endedAt: stamp,
      pid: null,
    };
    if (TERMINAL.includes(state)) {
      run.handle = null;
      // The attach credential has no use once the run is over.
      await fsp.rm(path.join(run.dir, 'attach.json'), { force: true }).catch(() => undefined);
    }
    this.deps.log(`run ${run.info.id} → ${state}`);
    await this.persist(run);
    await this.clearRunStamp(run, run.stopNote === undefined ? null : `${run.stopNote}${usageSummary(run.info)}`);
    // The slot is free and the ticket is where it belongs — the chain
    // may dispatch again (M85; a no-op while no chain is configured).
    void this.deps.onRunSettled?.(run.info);
  }

  /**
   * Clears the ticket's `run` map — the board's "at most one live run"
   * invariant. A failed write is logged, never thrown: the run record
   * itself is already durable.
   */
  private async clearRunStamp(run: LiveRun, note: string | null): Promise<void> {
    try {
      await this.patchTicket(run, (text) =>
        patchTicketFile(text, {
          to: run.currentPhase,
          from: null,
          now: this.now(),
          actor: this.agentActor(),
          clearRun: true,
          action: note ?? `run ${run.info.state}${usageSummary(run.info)}`,
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        // The ticket moved on (or was removed) since the run: nothing to clear.
        return;
      }
      this.deps.log(`run ${run.info.id}: clearing the ticket's run stamp failed — ${messageOf(error)}`);
    }
  }

  private async patchTicket(run: LiveRun, patch: (text: string) => string): Promise<void> {
    const abs = path.join(run.request.ticketsVaultPath, run.currentRelPath);
    const text = await fsp.readFile(abs, 'utf8');
    await fsp.writeFile(abs, patch(text), 'utf8');
    const location = await this.git.locate(run.request.ticketsVaultPath);
    if (location !== null) {
      await this.git.commitPaths(
        location.root,
        [`${location.prefix}${run.currentRelPath}`],
        `tickets: ${run.request.ticketId} fleet run bookkeeping`,
      );
    }
  }

  private async logLine(run: LiveRun, what: string): Promise<void> {
    try {
      await this.patchTicket(run, (text) =>
        patchTicketFile(text, {
          to: run.currentPhase,
          from: null,
          now: this.now(),
          actor: this.agentActor(),
          action: what,
        }),
      );
    } catch (error) {
      this.deps.log(`run ${run.info.id}: log line failed — ${messageOf(error)}`);
    }
    await this.appendStream(run, { ts: this.stamp(), kind: 'note', text: what });
  }

  private async appendStream(run: LiveRun, event: NormalizedEvent): Promise<void> {
    await fsp.appendFile(path.join(run.dir, 'stream.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  private async persist(run: LiveRun): Promise<void> {
    const stored: StoredRun = {
      request: run.request,
      info: run.info,
      ...(run.handover !== undefined ? { handover: run.handover } : {}),
      ...(run.usageBase !== undefined ? { usageBase: run.usageBase } : {}),
    };
    await fsp.writeFile(path.join(run.dir, 'run.json'), JSON.stringify(stored, null, 2), 'utf8');
  }

  private agentActor(): string {
    return `agent@${hostname().toLowerCase()}`;
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A gate failure's one line — what the ticket Log and a park reason may
 * carry (T-0048): the first non-empty line, whitespace-flattened, capped
 * at 300 chars. The multi-line block lives in `RunInfo.gateFailure` and
 * the retry instruction, never in a ticket action line.
 */
export function shortGateLine(text: string): string {
  const first =
    text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .find((line) => line !== '') ?? '';
  return first.length > 300 ? `${first.slice(0, 299)}…` : first;
}

/** The failed command's combined output — stdout and stderr, or the error's message. */
function combinedOutput(error: unknown): string {
  const err = error as { stdout?: unknown; stderr?: unknown };
  const out = [typeof err.stdout === 'string' ? err.stdout : '', typeof err.stderr === 'string' ? err.stderr : '']
    .join('\n')
    .trim();
  return out !== '' ? out : messageOf(error);
}
