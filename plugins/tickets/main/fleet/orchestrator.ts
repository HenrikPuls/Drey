/**
 * The chain orchestrator (M85, ADR-0077): the runner-side loop that
 * turns a configured pipeline into running workers. It reads the
 * tickets vault itself (pipeline.md, order.md, repos.md, the ticket
 * files — the same assembled board Drey renders), plans the next
 * dispatches with the pure rules of `chain.ts`, and starts runs through
 * the per-provider supervisors. Master and per-column control state
 * persist in `<root>/chain.json`; the tickets repo never sees it
 * (ADR-0076: no view state in the repo).
 *
 * The loop is event-driven with a slow safety net: a dispatch pass runs
 * when the config or a control state changes, when a run settles (its
 * slot freed — or its ticket moved right and fed the next pool), and
 * every scan interval so external board moves are picked up even with
 * Drey closed.
 */
import { promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import type { BoardColumn, BoardSnapshot, PipelinePhase } from '../../shared/tickets';
import { isValidTicketFile, parseHandover, stripPhasePrefix, TICKETS_ARCHIVE_DIR } from '../../shared/tickets';
import { assembleBoard, parseOrderFile, rewriteOrderSection, type BoardFile } from '../ticket-board';
import { patchTicketFile } from '../ticket-files';
import { TicketsGit } from '../tickets-git';
import { columnPromptRef, dispatchable, isAutoPhase, nextPhaseIdOf, planDispatch } from './chain';
import { composeRunRequest } from './request';
import { listTicketDirs, resolvePhaseDir } from '../phase-dirs';
import { execShell, shortGateLine, type SupervisorRecord, type StartOutcome, type StopOutcome } from './runs';
import { readRepoInstructions, worktreeDiffStat } from './context-pack';
import { worktreePathFor } from './worktree-home';
import type {
  ChainConfig,
  ChainMaster,
  ChainStatus,
  ColumnMode,
  FleetCaps,
  RunInfo,
  RunRequest,
  WorkerProviderId,
} from './protocol';
import { DEFAULT_FLEET_CAPS } from './protocol';

const CHAIN_FILE = 'chain.json';

/** The slice of RunSupervisor the orchestrator drives. */
export interface SupervisorPort {
  readonly start: (request: RunRequest) => Promise<StartOutcome>;
  readonly stop: (runId: string, reason: string | null) => Promise<StopOutcome>;
  readonly records: () => readonly SupervisorRecord[];
  /** The lease reaper round (M85). */
  readonly reap: () => Promise<void>;
}

export interface OrchestratorDeps {
  readonly root: string;
  readonly log: (message: string) => void;
  /** The supervisor that owns runs of this provider. */
  readonly supervisorOf: (provider: WorkerProviderId) => SupervisorPort;
  readonly now?: () => Date;
  /** The safety-net rescan interval (default 15 s). */
  readonly scanIntervalMs?: number;
  /** Test seam over the ci handover's shell exec (cwd = the work repo). */
  readonly execShell?: (command: string, cwd: string) => Promise<void>;
}

interface ChainFile {
  readonly version: 1;
  readonly config: ChainConfig | null;
  readonly master: ChainMaster;
  readonly columns: Record<string, ColumnMode>;
  readonly redStreak: Record<string, number>;
  readonly cooldownUntil: Record<string, string>;
  /** Per column: the day the token sum belongs to, and the sum itself. */
  readonly tokensDay: Record<string, string>;
  readonly tokensUsed: Record<string, number>;
  /** Per ticket: the ci check's next attempt (a failed check backs off). */
  readonly ciBackoff: Record<string, string>;
}

const LIVE: readonly string[] = ['starting', 'running', 'stopping'];
const BLOCKING: readonly string[] = ['starting', 'running', 'stopping', 'detached'];

/** Consecutive red gates a column tolerates without its own `max-red:`. */
export const DEFAULT_MAX_RED = 3;
/** The breather after a red gate before the column fires again. */
export const RED_COOLDOWN_MS = 60_000;
/** A failed ci check backs off before its next attempt. */
export const CI_BACKOFF_MS = 10 * 60_000;

/** The sampling audit's brief — a fresh second worker reviews the step. */
export const AUDIT_BRIEF =
  'You are the sampling auditor — a fresh second worker. Before this step may move on, review the work the branch ' +
  'contains against the ticket: correctness first, then the repo\'s conventions, then leftovers. Fix what you find; ' +
  'the machine gate must stay green when you end.';

/** The semantic gate's brief — does the branch do the thing, and only the thing. */
export const SEMANTIC_BRIEF =
  'You are the semantic gate — a fresh second worker. Judge the step\'s result against what the ticket actually asked ' +
  'for: does the branch do the thing, does it do only the thing, would the owner accept it? Fix what falls short; the ' +
  'machine gate must stay green when you end.';

export class Orchestrator {
  private config: ChainConfig | null = null;
  private master: ChainMaster = 'halted';
  private readonly columns: Record<string, ColumnMode> = {};
  private readonly redStreak: Record<string, number> = {};
  private readonly cooldownUntil: Record<string, string> = {};
  private readonly tokensDay: Record<string, string> = {};
  private readonly tokensUsed: Record<string, number> = {};
  private passing = false;
  private ciSweeping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The pipeline config of the last pass — the breaker's thresholds. */
  private lastPhases: readonly PipelinePhase[] = [];
  private readonly ciBackoff: Record<string, string> = {};
  /** Skip/wait lines already logged, ticket → line: a pass every 15 s
   *  must not repeat itself into the chain log. */
  private readonly notes = new Map<string, string>();
  /** Tickets noted during the current pass — the sweep keeps only these. */
  private notedThisPass = new Set<string>();
  /** The last held-column line, logged on change only. */
  private heldNote = '';

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Loads `<root>/chain.json` — the orchestration state resumes after a
   * runner restart, but the master never does: every boot starts halted,
   * "An" is a per-session decision (ADR-0077). A persisted "run" is
   * written back as halted so the disk matches what the board shows.
   */
  async load(): Promise<void> {
    const raw = await fsp.readFile(path.join(this.deps.root, CHAIN_FILE), 'utf8').catch(() => null);
    if (raw === null) {
      return;
    }
    let persistedRun = false;
    try {
      const parsed = JSON.parse(raw) as ChainFile;
      if (parsed.version !== 1) {
        return;
      }
      this.config = parsed.config;
      persistedRun = parsed.master === 'run';
      this.master = 'halted';
      for (const [phase, mode] of Object.entries(parsed.columns ?? {})) {
        if (mode === 'playing' || mode === 'held') {
          this.columns[phase] = mode;
        }
      }
      for (const [phase, streak] of Object.entries(parsed.redStreak ?? {})) {
        if (typeof streak === 'number' && streak >= 0) {
          this.redStreak[phase] = streak;
        }
      }
      for (const [phase, until] of Object.entries(parsed.cooldownUntil ?? {})) {
        if (typeof until === 'string' && !Number.isNaN(Date.parse(until))) {
          this.cooldownUntil[phase] = until;
        }
      }
      for (const [phase, day] of Object.entries(parsed.tokensDay ?? {})) {
        if (typeof day === 'string') {
          this.tokensDay[phase] = day;
        }
      }
      for (const [phase, used] of Object.entries(parsed.tokensUsed ?? {})) {
        if (typeof used === 'number' && used >= 0) {
          this.tokensUsed[phase] = used;
        }
      }
      for (const [ticket, until] of Object.entries(parsed.ciBackoff ?? {})) {
        if (typeof until === 'string' && !Number.isNaN(Date.parse(until))) {
          this.ciBackoff[ticket] = until;
        }
      }
    } catch {
      // a torn chain.json is noise; the plugin re-configures on the next board round
    }
    if (persistedRun) {
      await this.persist();
    }
    this.startTimer();
  }

  status(): ChainStatus {
    return {
      configured: this.config !== null,
      master: this.master,
      columns: { ...this.columns },
      redStreak: { ...this.redStreak },
      cooldownUntil: { ...this.cooldownUntil },
    };
  }

  /** Points the chain at a tickets vault (idempotent) and scans. */
  async configure(config: ChainConfig): Promise<ChainStatus> {
    const same =
      this.config !== null &&
      this.config.ticketsVaultPath === config.ticketsVaultPath &&
      this.config.git === config.git &&
      this.config.defaultWorker === config.defaultWorker &&
      this.config.permissionMode === config.permissionMode;
    this.config = config;
    if (!same) {
      await this.persist();
    }
    this.startTimer();
    await this.dispatchPass();
    return this.status();
  }

  async setMaster(mode: ChainMaster): Promise<ChainStatus> {
    this.master = mode;
    await this.persist();
    if (mode === 'run') {
      await this.dispatchPass();
    }
    return this.status();
  }

  async setColumn(phaseId: string, mode: ColumnMode): Promise<ChainStatus> {
    this.columns[phaseId] = mode;
    await this.persist();
    if (mode === 'playing') {
      await this.dispatchPass();
    }
    return this.status();
  }

  /** Notaus: halt the chain, then abort every live run through the stop ladder. */
  async abortAll(): Promise<ChainStatus> {
    this.master = 'halted';
    await this.persist();
    await this.stopRuns((record) => LIVE.includes(record.info.state), 'chain emergency stop (Notaus)');
    return this.status();
  }

  /** Stops one column's live runs and holds the column (the brake). */
  async stopColumn(phaseId: string): Promise<ChainStatus> {
    this.columns[phaseId] = 'held';
    await this.persist();
    await this.stopRuns(
      (record) => LIVE.includes(record.info.state) && (record.request.column ?? null) === phaseId,
      `column ${phaseId} stopped`,
    );
    return this.status();
  }

  /**
   * The supervisors' run-settled hook (M85): a slot freed, and — for a
   * dispatched run — the breaker's bookkeeping. Agent-done AND green
   * gate resets the column's red streak; a red gate raises it (and
   * cools the column down); over the `max-red` threshold the breaker
   * trips: the column holds and its next candidate parks in inbox.
   */
  async onRunSettled(info: RunInfo): Promise<void> {
    const record = this.allRecords().find((r) => r.info.id === info.id) ?? null;
    const column = record?.request.column ?? null;
    if (column !== null && record !== null) {
      const tokens = info.tokensIn + info.tokensOut;
      if (tokens > 0) {
        const day = this.stamp().slice(0, 10);
        if (this.tokensDay[column] !== day) {
          this.tokensDay[column] = day;
          this.tokensUsed[column] = 0;
        }
        this.tokensUsed[column] = (this.tokensUsed[column] ?? 0) + tokens;
      }
      if (info.state === 'done') {
        this.redStreak[column] = 0;
      }
      if (info.state === 'failed' && info.gateFailure !== null) {
        const streak = (this.redStreak[column] ?? 0) + 1;
        this.redStreak[column] = streak;
        this.cooldownUntil[column] = new Date(this.now().getTime() + RED_COOLDOWN_MS).toISOString();
        await this.persist();
        const maxRed = this.lastPhases.find((p) => p.id === column)?.maxRed ?? DEFAULT_MAX_RED;
        if (streak >= maxRed) {
          await this.trip(column, `${streak} red gates in a row`, info.gateFailure);
        } else {
          const budget = this.lastPhases.find((p) => p.id === column)?.tokenBudget ?? 0;
          if (budget > 0 && (this.tokensUsed[column] ?? 0) > budget) {
            await this.trip(column, 'daily token budget spent', info.gateFailure);
          } else {
            this.deps.log(`red gate on ${column} (${streak}/${maxRed}) — the column cools down`);
          }
        }
      } else {
        await this.persist();
      }
    }
    await this.dispatchPass();
  }

  /** The breaker trips: the column holds, its next candidate parks. */
  private async trip(column: string, reason: string, gateFailure: string): Promise<void> {
    this.columns[column] = 'held';
    this.deps.log(`circuit breaker tripped on ${column} — ${reason}; the column holds`);
    await this.persist();
    await this.parkNextCandidate(column, `${reason}; last gate: ${shortGateLine(gateFailure).slice(0, 200)}`);
  }

  /**
   * Parks the column's next candidate in inbox (`parked-reason`/
   * `parked-at`): the breaker's backward move is the machine's, with the
   * same one-commit semantics as every transition.
   */
  private async parkNextCandidate(column: string, reason: string): Promise<void> {
    const config = this.config;
    if (config === null) {
      return;
    }
    try {
      const snap = await readVaultBoard(config.ticketsVaultPath, config.defaultWorker);
      const col = snap.columns.find((c) => c.phase.id === column) ?? null;
      const candidate =
        col?.tickets.find((t) => t.meta.run === null && t.meta.claimedBy === null) ?? null;
      if (candidate === null) {
        this.deps.log(`the breaker found no candidate to park on ${column}`);
        return;
      }
      const git = new TicketsGit(() => config.git);
      const fromRel = candidate.path;
      const inboxDir = await phaseDirOf(config.ticketsVaultPath, snap.pipeline, 'inbox');
      const toRel = `tickets/${inboxDir}/${candidate.id}.md`;
      const abs = (rel: string): string => path.join(config.ticketsVaultPath, rel);
      const text = await fsp.readFile(abs(fromRel), 'utf8');
      const patched = patchTicketFile(text, {
        to: 'inbox',
        from: candidate.phase,
        now: this.now(),
        actor: this.agentActor(),
        action: `parked by the circuit breaker (${column}) — ${reason}`,
        park: reason,
      });
      await fsp.mkdir(path.dirname(abs(toRel)), { recursive: true });
      await fsp.rename(abs(fromRel), abs(toRel));
      await fsp.writeFile(abs(toRel), patched, 'utf8');
      await this.dropPin(config.ticketsVaultPath, candidate.id);
      const location = await git.locate(config.ticketsVaultPath);
      if (location !== null) {
        await git.commitPaths(
          location.root,
          [fromRel, toRel].map((p) => `${location.prefix}${p}`),
          `tickets: ${candidate.id} ${candidate.phase} -> inbox (circuit breaker)`,
        );
      }
      this.deps.log(`parked ${candidate.id} in inbox (${column} breaker) — re-prioritizing revives it`);
    } catch (error) {
      this.deps.log(`parking the breaker's candidate failed: ${error instanceof Error ? error.message : String(error)}`);
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

  /** The supervisors' lease-reaper round (the runner's timer calls this). */
  async reapAll(): Promise<void> {
    for (const provider of ['opencode', 'claude-code'] as const) {
      await this.deps.supervisorOf(provider).reap();
    }
  }

  /**
   * The quality rungs' decision (M85, flagged off): a dispatched run in
   * a column with `audit:` (sampled by fraction) or `semantic: true`
   * (always) gets a second worker before its move — the brief prefixes
   * the run's own instruction, so the review keeps the whole brief.
   */
  async secondOpinion(request: RunRequest): Promise<string | null> {
    const column = request.column ?? null;
    if (column === null) {
      return null;
    }
    const phase = this.lastPhases.find((p) => p.id === column);
    if (phase === undefined) {
      return null;
    }
    const sampled = phase.audit !== null && Math.random() < phase.audit;
    if (!sampled && phase.semantic !== true) {
      return null;
    }
    const brief = phase.semantic === true ? SEMANTIC_BRIEF : AUDIT_BRIEF;
    return `${brief}\n\n---\n\n${request.instruction}`;
  }

  private agentActor(): string {
    return `agent@${hostname().toLowerCase()}`;
  }

  private stamp(): string {
    return (this.deps.now ?? ((): Date => new Date()))().toISOString();
  }

  private now(): Date {
    const now = this.deps.now;
    return now === undefined ? new Date() : now();
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** True while the chain would dispatch again — the idle shutdown waits on this. */
  get active(): boolean {
    return this.config !== null && this.master === 'run';
  }

  // -------------------------------------------------------------------------

  private startTimer(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      if (this.config !== null) {
        void this.ciSweep();
      }
      if (this.active) {
        void this.dispatchPass();
      }
    }, this.deps.scanIntervalMs ?? 15_000);
    this.timer.unref();
  }

  /**
   * The ci handover's round (M85): a `handover: ci` column leaves its
   * tickets to an executable check — green moves one column right (the
   * runner performs the move, machine semantics, one commit), red backs
   * the ticket off for ten minutes. Checks run in the ticket's work
   * repo, outside the dispatch pass, so a slow check never blocks a
   * dispatch.
   */
  private async ciSweep(): Promise<void> {
    const config = this.config;
    if (config === null || this.ciSweeping) {
      return;
    }
    this.ciSweeping = true;
    try {
      const snap = await readVaultBoard(config.ticketsVaultPath, config.defaultWorker);
      this.lastPhases = snap.pipeline;
      for (const column of snap.columns) {
        const phase = column.phase;
        if (parseHandover(phase.handover).mode !== 'ci' || phase.ci === null) {
          continue;
        }
        if ((this.columns[phase.id] ?? 'playing') !== 'playing' || this.master !== 'run') {
          continue;
        }
        const nextPhaseId = nextPhaseIdOf(snap.columns, phase.id);
        if (nextPhaseId === null) {
          continue;
        }
        for (const card of column.tickets) {
          if (card.meta.run !== null || card.meta.claimedBy !== null) {
            continue;
          }
          const backoff = this.ciBackoff[card.id];
          if (backoff !== undefined && this.now().getTime() < Date.parse(backoff)) {
            continue;
          }
          await this.runCiCheck(config, snap, phase, nextPhaseId, card);
          if (await cardMovedOff(config.ticketsVaultPath, card.path)) {
            break; // the sweep's column snapshot is stale — the next tick re-reads
          }
        }
      }
    } catch (error) {
      this.deps.log(`ci sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ciSweeping = false;
    }
  }

  private async runCiCheck(
    config: ChainConfig,
    snap: BoardSnapshot,
    phase: PipelinePhase,
    nextPhaseId: string,
    card: BoardColumn['tickets'][number],
  ): Promise<void> {
    const repo =
      card.meta.repo === null ? null : (snap.repos.find((r) => r.name === card.meta.repo) ?? null);
    if (repo === null || repo.path === null || phase.ci === null) {
      return; // a card without a checkout is the board's badge, not the runner's guess
    }
    const command = phase.ci;
    this.deps.log(`ci ${phase.id}: ${card.id} — ${command}`);
    try {
      await (this.deps.execShell ?? execShell)(command, repo.path);
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? 'failed';
      this.ciBackoff[card.id] = new Date(this.now().getTime() + CI_BACKOFF_MS).toISOString();
      await this.persist();
      await this.appendTicketLog(config, card, `ci check failed — ${detail.slice(0, 300)} (retry in 10 min)`);
      return;
    }
    const nextClaims = snap.pipeline.find((p) => p.id === nextPhaseId)?.claim === true;
    const moved = await this.moveTicketForward(config, card, nextPhaseId, `ci check passed — moving to ${nextPhaseId}`, nextClaims);
    if (moved) {
      delete this.ciBackoff[card.id];
      await this.persist();
    }
  }

  /** One forward move performed by the machine (ci): move + stamp + one commit. */
  private async moveTicketForward(
    config: ChainConfig,
    card: BoardColumn['tickets'][number],
    nextPhaseId: string,
    action: string,
    claims: boolean,
  ): Promise<boolean> {
    try {
      const git = new TicketsGit(() => config.git);
      const abs = (rel: string): string => path.join(config.ticketsVaultPath, rel);
      const fromRel = card.path;
      const pipeline = (await readVaultBoard(config.ticketsVaultPath, config.defaultWorker)).pipeline;
      const toRel = `tickets/${await phaseDirOf(config.ticketsVaultPath, pipeline, nextPhaseId)}/${card.id}.md`;
      const text = await fsp.readFile(abs(fromRel), 'utf8');
      const patched = patchTicketFile(text, {
        to: nextPhaseId,
        from: card.phase,
        now: this.now(),
        actor: this.agentActor(),
        action,
        ...(claims ? { claimBy: this.agentActor() } : { releaseClaim: true }),
      });
      await fsp.mkdir(path.dirname(abs(toRel)), { recursive: true });
      await fsp.rename(abs(fromRel), abs(toRel));
      await fsp.writeFile(abs(toRel), patched, 'utf8');
      await this.dropPin(config.ticketsVaultPath, card.id);
      const location = await git.locate(config.ticketsVaultPath);
      if (location !== null) {
        await git.commitPaths(
          location.root,
          [fromRel, toRel].map((p) => `${location.prefix}${p}`),
          `tickets: ${card.id} ${card.phase} -> ${nextPhaseId} (ci)`,
        );
      }
      this.deps.log(`ci moved ${card.id} to ${nextPhaseId}`);
      return true;
    } catch (error) {
      this.deps.log(`the ci move failed for ${card.id}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Appends a Log line to the ticket file (one commit; failures logged, never thrown). */
  private async appendTicketLog(
    config: ChainConfig,
    card: BoardColumn['tickets'][number],
    what: string,
  ): Promise<void> {
    try {
      const git = new TicketsGit(() => config.git);
      const abs = path.join(config.ticketsVaultPath, card.path);
      const text = await fsp.readFile(abs, 'utf8');
      const patched = patchTicketFile(text, {
        to: card.phase,
        from: null,
        now: this.now(),
        actor: this.agentActor(),
        action: what,
      });
      await fsp.writeFile(abs, patched, 'utf8');
      const location = await git.locate(config.ticketsVaultPath);
      if (location !== null) {
        await git.commitPaths(
          location.root,
          [`${location.prefix}${card.path}`],
          `tickets: ${card.id} ci bookkeeping`,
        );
      }
    } catch (error) {
      this.deps.log(`the ci log line failed for ${card.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private allRecords(): readonly SupervisorRecord[] {
    // One run belongs to exactly one supervisor; a port that serves
    // several providers (a test fake) must not duplicate its records.
    const byId = new Map<string, SupervisorRecord>();
    for (const provider of ['opencode', 'claude-code'] as const) {
      for (const record of this.deps.supervisorOf(provider).records()) {
        if (!byId.has(record.info.id)) {
          byId.set(record.info.id, record);
        }
      }
    }
    return [...byId.values()];
  }

  private async stopRuns(
    matches: (record: SupervisorRecord) => boolean,
    reason: string,
  ): Promise<void> {
    const stops = this.allRecords()
      .filter(matches)
      .map((record) =>
        this.deps
          .supervisorOf(record.info.provider)
          .stop(record.info.id, reason)
          .catch(() => undefined),
      );
    await Promise.all(stops);
  }

  /**
   * The ticket's most recent failed run's gate failure, or null (T-0048):
   * what a retry's instruction carries so the worker fixes the gate
   * first and continues from the branch instead of starting over. No new
   * state — the supervisors' records are the truth.
   */
  private lastGateFailure(ticketId: string): string | null {
    const failed = this.allRecords()
      .filter((r) => r.info.ticketId === ticketId && r.info.state === 'failed' && r.info.gateFailure !== null)
      .sort((a, b) => b.info.startedAt.localeCompare(a.info.startedAt))[0];
    return failed?.info.gateFailure ?? null;
  }

  private async persist(): Promise<void> {
    const file: ChainFile = {
      version: 1,
      config: this.config,
      master: this.master,
      columns: { ...this.columns },
      redStreak: { ...this.redStreak },
      cooldownUntil: { ...this.cooldownUntil },
      tokensDay: { ...this.tokensDay },
      tokensUsed: { ...this.tokensUsed },
      ciBackoff: { ...this.ciBackoff },
    };
    await fsp
      .writeFile(path.join(this.deps.root, CHAIN_FILE), `${JSON.stringify(file, null, 2)}\n`, 'utf8')
      .catch((error) => this.deps.log(`chain.json write failed: ${String(error)}`));
  }

  /** One dispatch round: read the vault, plan, start what is due. */
  private async dispatchPass(): Promise<void> {
    const config = this.config;
    if (config === null || this.passing) {
      return;
    }
    this.passing = true;
    try {
      const snap = await readVaultBoard(config.ticketsVaultPath, config.defaultWorker);
      if (snap.pipeline.length === 0) {
        return;
      }
      const liveByColumn: Record<string, number> = {};
      const busyTickets = new Set<string>();
      for (const record of this.allRecords()) {
        if (LIVE.includes(record.info.state)) {
          const column = record.request.column ?? null;
          if (column !== null) {
            liveByColumn[column] = (liveByColumn[column] ?? 0) + 1;
          }
        }
        if (BLOCKING.includes(record.info.state)) {
          busyTickets.add(record.info.ticketId);
        }
      }
      const plan = planDispatch({
        master: this.master,
        columns: snap.columns,
        modes: this.columns,
        liveByColumn,
        busyTickets,
        cooldownUntil: this.cooldownUntil,
        nowMs: this.now().getTime(),
      });
      this.lastPhases = snap.pipeline;
      this.notedThisPass = new Set();
      const dispatched = new Set<string>(plan.map((item) => item.card.id));
      for (const item of plan) {
        await this.dispatchOne(config, snap.columns, item.workingPhase, item.card, snap);
      }
      const detachedTickets = new Set<string>(
        this.allRecords()
          .filter((record) => record.info.state === 'detached')
          .map((record) => record.info.ticketId),
      );
      this.noteWaits(snap, busyTickets, dispatched, detachedTickets);
      for (const ticket of [...this.notes.keys()]) {
        if (!this.notedThisPass.has(ticket)) {
          this.notes.delete(ticket);
        }
      }
    } catch (error) {
      this.deps.log(`dispatch pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.passing = false;
    }
  }

  /** Logs a per-ticket note once — a later pass with the same reason is
   *  silent, a changed reason logs again. */
  private noteSkip(ticketId: string, line: string): void {
    this.notedThisPass.add(ticketId);
    if (this.notes.get(ticketId) !== line) {
      this.notes.set(ticketId, line);
      this.deps.log(line);
    }
  }

  /**
   * The silent cases the plan leaves behind: a held column with a
   * waiting candidate, a claim or a leftover run stamp parking a ticket
   * in a playing column. The chain log should say WHY nothing moves —
   * the owner once watched ten silent minutes with no explanation.
   */
  private noteWaits(
    snap: BoardSnapshot,
    busy: ReadonlySet<string>,
    dispatched: ReadonlySet<string>,
    detached: ReadonlySet<string>,
  ): void {
    if (this.master !== 'run') {
      return; // the chain is off — silence is the honest state
    }
    const held: string[] = [];
    for (const column of snap.columns) {
      const mode = this.columns[column.phase.id] ?? 'playing';
      for (const card of column.tickets) {
        if (dispatched.has(card.id)) {
          continue;
        }
        if (busy.has(card.id)) {
          // A detached run (the runner restarted while its worker lived on)
          // blocks its ticket until it is stopped — say so, or the column
          // looks idle for no reason.
          if (detached.has(card.id) && mode !== 'held' && isAutoPhase(column.phase)) {
            this.noteSkip(
              card.id,
              `dispatch holds ${card.id}: a detached run still blocks it — stop the run (its worker may still be alive) to free the ticket`,
            );
          }
          continue;
        }
        if (mode === 'held') {
          if (dispatchable(card, busy)) {
            held.push(card.id);
          }
          continue;
        }
        if (!isAutoPhase(column.phase)) {
          continue; // manual columns are the owner's queue — silence there
        }
        if (card.meta.claimedBy !== null) {
          this.noteSkip(card.id, `dispatch holds ${card.id}: claimed by ${card.meta.claimedBy} — the pool waits`);
        } else if (card.meta.run !== null) {
          this.noteSkip(
            card.id,
            `dispatch holds ${card.id}: a run stamp without a live run — stop or resume the detached run`,
          );
        }
      }
    }
    const heldLine =
      held.length > 0
        ? `${held.join(', ')} ${held.length === 1 ? 'waits' : 'wait'} in a held column — switch the column to playing or move the ticket`
        : '';
    if (heldLine !== this.heldNote) {
      this.heldNote = heldLine;
      if (heldLine !== '') {
        this.deps.log(heldLine);
      }
    }
  }

  private async dispatchOne(
    config: ChainConfig,
    columns: readonly BoardColumn[],
    workingPhaseId: string,
    card: BoardColumn['tickets'][number],
    snap: BoardSnapshot,
  ): Promise<void> {
    const workingPhase = snap.pipeline.find((p) => p.id === workingPhaseId) ?? null;
    const repo =
      card.meta.repo === null ? null : (snap.repos.find((r) => r.name === card.meta.repo) ?? null);
    if (workingPhase === null || repo === null) {
      this.noteSkip(
        card.id,
        `dispatch skips ${card.id}: ${repo === null ? `repo "${card.meta.repo ?? ''}" is not in repos.md` : 'unknown working phase'}`,
      );
      return;
    }
    const promptRef = columnPromptRef(workingPhase);
    let promptText: string | null = null;
    if (promptRef !== null) {
      promptText = await fsp
        .readFile(path.join(config.ticketsVaultPath, 'tickets', '_meta', 'prompts', `${promptRef}.md`), 'utf8')
        .catch(() => null);
      if (promptText === null) {
        this.noteSkip(
          card.id,
          `dispatch skips ${card.id}: prompt "${promptRef}" is missing (tickets/_meta/prompts/${promptRef}.md)`,
        );
        return;
      }
    }
    const nextPhaseId = nextPhaseIdOf(columns, workingPhaseId);
    const nextPhaseClaims =
      nextPhaseId !== null ? snap.pipeline.find((p) => p.id === nextPhaseId)?.claim === true : false;
    const text = await fsp
      .readFile(path.join(config.ticketsVaultPath, card.path), 'utf8')
      .catch(() => null);
    if (text === null) {
      this.noteSkip(card.id, `dispatch skips ${card.id}: the ticket file is unreadable`);
      return;
    }
    // The context pack (T-0048): the repo's agent instructions and the
    // worktree's diff stat are read here, outside the pure composer; a
    // retry also carries the ticket's most recent gate failure. A repo
    // without a checkout lets the request builder refuse below.
    const repoInstructions = repo.path === null ? null : await readRepoInstructions(repo.path);
    const gateFailure = this.lastGateFailure(card.id);
    const diffStat =
      repo.path === null
        ? null
        : await worktreeDiffStat(
            new TicketsGit(() => config.git),
            worktreePathFor(config.ticketsVaultPath, repo, card.id),
            repo.branch,
          );
    if (gateFailure !== null && diffStat === null) {
      // A first run has nothing to show (silent); a retry expects to
      // continue existing work, so a missing stat is worth a line.
      this.deps.log(`instruction: ${card.id} diff stat unavailable (no worktree yet)`);
    }
    // The pipeline's first worker column takes in fresh tickets: a run
    // there gates structurally (the plan WRITES the acceptance criteria)
    // instead of demanding criteria the ticket cannot have yet.
    const firstWorker = snap.pipeline.find((p) => isAutoPhase(p)) ?? null;
    const composed = composeRunRequest({
      card,
      ticketText: text,
      vaultPath: config.ticketsVaultPath,
      workingPhase,
      nextPhaseId,
      nextPhaseDir:
        nextPhaseId === null
          ? null
          : resolvePhaseDir(
              await listTicketDirs(path.join(config.ticketsVaultPath, 'tickets')),
              snap.pipeline.findIndex((p) => p.id === nextPhaseId) + 1,
              nextPhaseId,
            ),
      pushRemote: snap.pushRemote,
      nextPhaseClaims,
      repo,
      promptText,
      defaultWorker: config.defaultWorker,
      permissionMode: config.permissionMode,
      gitPath: config.git,
      workerChoice: null,
      repoInstructions,
      diffStat,
      gateFailure,
      caps: config.caps ?? DEFAULT_FLEET_CAPS,
      structuralGateAllowed: firstWorker?.id === workingPhaseId,
      dispatchedBy: workingPhaseId,
    });
    if (!composed.ok) {
      this.noteSkip(card.id, `dispatch skips ${card.id}: ${composed.error}`);
      return;
    }
    for (const truncation of composed.truncations) {
      this.deps.log(
        `instruction: ${card.id} ${truncation.section} truncated: true, originalSize ${truncation.originalSize}`,
      );
    }
    const outcome = await this.deps.supervisorOf(composed.request.provider).start(composed.request);
    if (outcome.ok) {
      this.deps.log(
        `dispatched ${card.id} (${workingPhaseId} pool, ${composed.request.provider}` +
          `${composed.request.model !== null ? `/${composed.request.model}` : ''}) as ${outcome.run.id}`,
      );
      this.notes.delete(card.id);
    } else {
      this.noteSkip(card.id, `dispatch refused ${card.id}: ${outcome.error}`);
    }
  }
}

/** True when the ticket file no longer sits where the snapshot saw it. */
async function cardMovedOff(vaultPath: string, relPath: string): Promise<boolean> {
  try {
    await fsp.access(path.join(vaultPath, relPath));
    return false;
  } catch {
    return true;
  }
}

/** Assembles the board the same way Drey does — from the vault's files. */
export async function readVaultBoard(vaultPath: string, defaultWorker: string): Promise<BoardSnapshot> {  const ticketsDir = path.join(vaultPath, 'tickets');
  const entries = await fsp.readdir(ticketsDir, { withFileTypes: true }).catch(() => []);
  const files: BoardFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '_meta' || `tickets/${entry.name}` === TICKETS_ARCHIVE_DIR) {
      continue;
    }
    const dir = path.join(ticketsDir, entry.name);
    const names = await fsp.readdir(dir).catch(() => []);
    for (const name of names) {
      if (!isValidTicketFile(name)) {
        continue;
      }
      const text = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => null);
      if (text !== null) {
        files.push({ path: `tickets/${entry.name}/${name}`, text });
      }
    }
  }
  const read = async (rel: string): Promise<string | null> =>
    fsp.readFile(path.join(vaultPath, rel), 'utf8').catch(() => null);
  const [pipelineText, orderText, reposText] = await Promise.all([
    read('tickets/_meta/pipeline.md'),
    read('tickets/_meta/order.md'),
    read('tickets/_meta/repos.md'),
  ]);
  return assembleBoard({
    vaultId: null,
    vaultName: null,
    activeVaultName: null,
    isGitRepo: false,
    defaultWorker,
    pipelineText,
    orderText,
    reposText,
    files,
  });
}

/** The directory a machine move into `phaseId` writes (T-0041): resolved
 *  against the directories on disk, never rebuilt from the bare id. */
async function phaseDirOf(
  vaultPath: string,
  pipeline: readonly PipelinePhase[],
  phaseId: string,
): Promise<string> {
  const position = pipeline.findIndex((p) => p.id === phaseId) + 1;
  const dirs = await listTicketDirs(path.join(vaultPath, 'tickets'));
  return position === 0 ? (dirs.find((d) => stripPhasePrefix(d) === phaseId) ?? phaseId) : resolvePhaseDir(dirs, position, phaseId);
}
