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
import { exec as nodeExec } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { parseOrderFile, rewriteOrderSection } from '../ticket-board';
import { patchTicketFile } from '../ticket-files';
import { TicketsGit } from '../tickets-git';
import type { NormalizedEvent, ProviderAdapter, WorkerHandle } from './providers';
import { killTreeGuarded, processAlive, type ExecFn } from './procs';
import type { RunInfo, RunRequest, RunState, SteerRung } from './protocol';

const execAsync = promisify(nodeExec);

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
}

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
  readonly prepareWorktree?: (request: RunRequest, worktreePath: string) => Promise<void>;
  /** Test seam over the tickets repo's git (the spec recorder). */
  readonly ticketsGit?: Pick<TicketsGit, 'run' | 'locate' | 'commitPaths'>;
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
}

const TERMINAL: readonly RunState[] = ['done', 'stopped', 'failed'];

export class RunSupervisor {
  private readonly runs = new Map<string, LiveRun>();
  private readonly git: Pick<TicketsGit, 'run' | 'locate' | 'commitPaths'>;
  private readonly now: () => Date;
  private readonly exec: ExecFn;
  private readonly prepareWorktree: (request: RunRequest, worktreePath: string) => Promise<void>;

  constructor(private readonly deps: RunSupervisorDeps) {
    this.git = deps.ticketsGit ?? new TicketsGit(() => deps.git);
    this.now = deps.now ?? ((): Date => new Date());
    this.exec =
      deps.exec ??
      (async (cmd, args) => {
        const { stdout } = await execAsync(`${cmd} ${args.join(' ')}`, {
          cwd: this.deps.root,
          windowsHide: true,
        });
        return stdout;
      });
    this.prepareWorktree =
      deps.prepareWorktree ??
      (async (request, worktreePath) => {
        await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
        // The branch usually exists (created when the ticket was planned);
        // a missing branch is created from the repo's base ref.
        const hasBranch = await this.git
          .run(request.repoPath, ['rev-parse', '--verify', request.branch])
          .then(() => true)
          .catch(() => false);
        const args = hasBranch
          ? ['worktree', 'add', worktreePath, request.branch]
          : ['worktree', 'add', '-b', request.branch, worktreePath, request.baseRef ?? 'HEAD'];
        try {
          await this.git.run(request.repoPath, args);
        } catch (error) {
          // A settled run's worktree is a valid home for a re-run: reuse
          // it when git has it registered for the same branch; otherwise
          // surface git's error (T-0007 review: twenty silent start
          // failures against an existing worktree).
          if (!(await this.isRegisteredWorktree(request.repoPath, worktreePath, request.branch))) {
            throw error;
          }
        }
      });
  }

  /** True when `worktreePath` is a registered worktree checked out on `branch`. */
  private async isRegisteredWorktree(repo: string, worktreePath: string, branch: string): Promise<boolean> {
    const out = await this.git.run(repo, ['worktree', 'list', '--porcelain']).catch(() => '');
    const normalize = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const wanted = normalize(worktreePath);
    const lines = out.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.startsWith('worktree ')) {
        continue;
      }
      if (normalize(lines[i]!.slice('worktree '.length).trim()) !== wanted) {
        continue;
      }
      for (let j = i + 1; j < lines.length && lines[j] !== ''; j++) {
        if (lines[j]!.startsWith('branch ')) {
          if (lines[j]!.slice('branch '.length).trim() === `refs/heads/${branch}`) {
            return true;
          }
          break;
        }
      }
    }
    return false;
  }

  /**
   * Loads persisted runs after a runner restart. Terminal records come
   * back as history; a non-terminal record has no supervised worker
   * anymore (v1 does not re-attach), so it is marked `detached` and its
   * ticket's run slot freed — the owner can watch the leftover stream
   * file or start fresh.
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
        const dir = path.join(runsDir, id);
        if (TERMINAL.includes(stored.info.state)) {
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
          });
          continue;
        }
        const detached: RunInfo = {
          ...stored.info,
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
        };
        this.runs.set(detached.id, live);
        await this.persist(live);
        await this.clearRunStamp(live, 'the runner restarted — the worker is detached, start fresh to resume');
      } catch {
        // a torn run.json is noise; skip the run
      }
    }
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

  async start(request: RunRequest): Promise<StartOutcome> {
    const live = this.list().find(
      (r) => r.ticketId === request.ticketId && !TERMINAL.includes(r.state) && r.state !== 'detached',
    );
    if (live !== undefined) {
      return { ok: false, error: `${request.ticketId} already has a live run (${live.id}) — stop it first` };
    }
    const failures = this.validate(request);
    if (failures.length > 0) {
      return { ok: false, error: failures.join(' ') };
    }

    const id = `R-${this.stamp().replaceAll(/[-:.]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(this.deps.root, 'runs', id);
    const worktreePath = path.join(
      this.deps.root,
      'worktrees',
      `${request.repoPath.split(/[\\/]/).at(-1) ?? 'repo'}-${request.ticketId}`,
    );

    try {
      await fsp.mkdir(dir, { recursive: true });
      await this.prepareWorktree(request, worktreePath);
    } catch (error) {
      return { ok: false, error: `worktree failed: ${messageOf(error)}` };
    }

    const info: RunInfo = {
      id,
      ticketId: request.ticketId,
      provider: request.provider,
      state: 'starting',
      pid: null,
      startedAt: this.stamp(),
      endedAt: null,
      sessionRef: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      lastActivity: this.stamp(),
      steerCount: 0,
      lastSteerRung: null,
      worktreePath,
      branch: request.branch,
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
    };
    this.runs.set(id, run);
    await fsp.writeFile(
      path.join(dir, 'stream.jsonl'),
      `${JSON.stringify({ ts: this.stamp(), kind: 'note', text: `run ${id} for ${request.ticketId} on ${request.branch}` })}\n`,
      'utf8',
    );

    const handle = this.deps.adapter.spawn({
      cwd: worktreePath,
      instruction: request.instruction,
      model: request.model,
      permissionMode: request.permissionMode,
      resumeRef: null,
      ticketId: request.ticketId,
      onEvent: (event) => void this.onEvent(run, event),
      onSessionRef: (ref) => {
        run.info = { ...run.info, sessionRef: ref };
        void this.persist(run);
      },
    });
    run.handle = handle;
    run.info = { ...run.info, state: 'running', pid: handle.pid };
    await this.persist(run);

    // The ticket carries the live run (schema `run` map) — the board and
    // any fleet surface can see at most one live run per ticket.
    await this.patchTicket(run, (text) =>
      patchTicketFile(text, {
        to: request.phase,
        from: null,
        now: this.now(),
        actor: this.agentActor(),
        action: `run ${id} started (${request.provider}${request.model !== null ? `, ${request.model}` : ''})`,
        ...(request.recordWorker !== undefined && request.recordWorker !== '' ? { setWorker: request.recordWorker } : {}),
        ...(handle.pid !== null
          ? { run: { pid: handle.pid, 'started-at': this.stamp(), stream: id } }
          : {}),
      }),
    );

    void handle.exited.then((code) => void this.onWorkerExit(run, code));
    return { ok: true, run: run.info };
  }

  async stop(runId: string, reason: string | null): Promise<StopOutcome> {
    const run = this.runs.get(runId);
    if (run === undefined) {
      return { ok: false, error: `unknown run "${runId}"` };
    }
    if (TERMINAL.includes(run.info.state) || run.info.state === 'detached') {
      return { ok: false, error: `run ${runId} already ended (${run.info.state})` };
    }
    run.info = { ...run.info, state: 'stopping' };
    await this.logLine(run, `stopped by the owner${reason !== null ? ` — ${reason}` : ''}`);
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
    const rung = await run.handle.steer(text);
    run.info = { ...run.info, steerCount: run.info.steerCount + 1, lastSteerRung: rung };
    await this.persist(run);
    await this.logLine(run, `steer (${rung}): ${text.slice(0, 200)}`);
    if (rung === 'refused') {
      return { ok: false, error: `the ${run.info.provider} worker took no message — it may have ended` };
    }
    return { ok: true, rung };
  }

  /** True while at least one run is starting/running — the idle shutdown waits on this. */
  hasLive(): boolean {
    return this.list().some((r) => !TERMINAL.includes(r.state) && r.state !== 'detached');
  }

  // -------------------------------------------------------------------------

  /** The rules the runner enforces itself (ADR-0076: the validator runs where the data is). */
  private validate(request: RunRequest): readonly string[] {
    const failures: string[] = [];
    if (!/^T-\d{4,}$/.test(request.ticketId)) {
      failures.push(`"${request.ticketId}" is not a ticket id`);
    }
    if (request.ticketRelPath !== `tickets/${request.phase}/${request.ticketId}.md`) {
      failures.push(`the ticket path does not match id and phase (${request.ticketRelPath})`);
    }
    if (request.instruction.trim() === '') {
      failures.push('the instruction is empty');
    }
    if (request.branch !== `t/${request.ticketId}`) {
      failures.push(`the branch is not the deterministic t/${request.ticketId}`);
    }
    if (request.acceptance.length === 0) {
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
    await this.appendStream(run, event);
    run.info = {
      ...run.info,
      lastActivity: event.ts,
      ...(event.tokensIn !== undefined ? { tokensIn: event.tokensIn } : {}),
      ...(event.tokensOut !== undefined ? { tokensOut: event.tokensOut } : {}),
      ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
    };
    if (event.kind === 'error') {
      this.deps.log(`run ${run.info.id}: ${event.text ?? 'error'}`);
    }
    await this.persist(run);
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
      if (TERMINAL.includes(state) || state === 'detached' || state === 'stopping' || run.gating) {
        continue;
      }
      const pid = run.info.pid;
      if (pid === null) {
        // A spawn that never produced a worker: lost after two minutes.
        if (this.now().getTime() - run.startedAtMs > 2 * 60_000) {
          run.info = { ...run.info, gateFailure: 'lease lost — the worker never started; reaped' };
          await this.logLine(run, 'lease reaper: the worker never started — run reaped, ticket freed');
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

  /** The machine gate: the ticket's acceptance commands, in order, in the worktree. */
  private async runGate(run: LiveRun): Promise<string | null> {
    for (const command of run.request.acceptance) {
      await this.logLine(run, `gate: ${command}`);
      try {
        await (this.deps.execShell ?? execShell)(command, run.info.worktreePath);
      } catch (error) {
        const detail = messageOf(error).split('\n')[0] ?? 'failed';
        return `\`${command}\` failed — ${detail.slice(0, 300)}`;
      }
    }
    return null;
  }

  private async onWorkerExit(run: LiveRun, code: number | null): Promise<void> {
    if (TERMINAL.includes(run.info.state)) {
      return; // the lease reaper got here first
    }
    if (run.info.state === 'stopping') {
      await this.finish(run, 'stopped');
      return;
    }
    if (run.info.state === 'detached') {
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
    run.gating = true;
    const failure = await this.runGate(run);
    if (failure !== null) {
      run.info = { ...run.info, gateFailure: failure };
      await this.logLine(run, `machine gate failed — ${failure}`);
      await this.finish(run, 'failed');
      return;
    }
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
    const newRel = `tickets/${nextPhase}/${request.ticketId}.md`;
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
    run.info = {
      ...run.info,
      state,
      endedAt: this.stamp(),
      pid: null,
    };
    if (TERMINAL.includes(state)) {
      run.handle = null;
    }
    this.deps.log(`run ${run.info.id} → ${state}`);
    await this.persist(run);
    await this.clearRunStamp(run, null);
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
          action: note ?? `run ${run.info.state}`,
        }),
      );
    } catch (error) {
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
    const stored: StoredRun = { request: run.request, info: run.info };
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
