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
import * as path from 'node:path';
import type { BoardColumn, BoardSnapshot } from '../../shared/tickets';
import { isValidTicketFile } from '../../shared/tickets';
import { assembleBoard, type BoardFile } from '../ticket-board';
import { columnPromptRef, nextPhaseIdOf, planDispatch } from './chain';
import { composeRunRequest } from './request';
import type { SupervisorRecord, StartOutcome, StopOutcome } from './runs';
import type {
  ChainConfig,
  ChainMaster,
  ChainStatus,
  ColumnMode,
  RunInfo,
  RunRequest,
  WorkerProviderId,
} from './protocol';

const CHAIN_FILE = 'chain.json';

/** The slice of RunSupervisor the orchestrator drives. */
export interface SupervisorPort {
  readonly start: (request: RunRequest) => Promise<StartOutcome>;
  readonly stop: (runId: string, reason: string | null) => Promise<StopOutcome>;
  readonly records: () => readonly SupervisorRecord[];
}

export interface OrchestratorDeps {
  readonly root: string;
  readonly log: (message: string) => void;
  /** The supervisor that owns runs of this provider. */
  readonly supervisorOf: (provider: WorkerProviderId) => SupervisorPort;
  readonly now?: () => Date;
  /** The safety-net rescan interval (default 15 s). */
  readonly scanIntervalMs?: number;
}

interface ChainFile {
  readonly version: 1;
  readonly config: ChainConfig | null;
  readonly master: ChainMaster;
  readonly columns: Record<string, ColumnMode>;
}

const LIVE: readonly string[] = ['starting', 'running', 'stopping'];
const BLOCKING: readonly string[] = ['starting', 'running', 'stopping', 'detached'];

export class Orchestrator {
  private config: ChainConfig | null = null;
  private master: ChainMaster = 'halted';
  private readonly columns: Record<string, ColumnMode> = {};
  private passing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Loads `<root>/chain.json` — orchestration resumes after a runner restart. */
  async load(): Promise<void> {
    const raw = await fsp.readFile(path.join(this.deps.root, CHAIN_FILE), 'utf8').catch(() => null);
    if (raw === null) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as ChainFile;
      if (parsed.version !== 1) {
        return;
      }
      this.config = parsed.config;
      this.master = parsed.master === 'run' ? 'run' : 'halted';
      for (const [phase, mode] of Object.entries(parsed.columns ?? {})) {
        if (mode === 'playing' || mode === 'held') {
          this.columns[phase] = mode;
        }
      }
    } catch {
      // a torn chain.json is noise; the plugin re-configures on the next board round
    }
    this.startTimer();
  }

  status(): ChainStatus {
    return {
      configured: this.config !== null,
      master: this.master,
      columns: { ...this.columns },
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

  /** The supervisors' run-settled hook: a slot freed — dispatch again. */
  onRunSettled(): void {
    void this.dispatchPass();
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
      if (this.active) {
        void this.dispatchPass();
      }
    }, this.deps.scanIntervalMs ?? 15_000);
    this.timer.unref();
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

  private async persist(): Promise<void> {
    const file: ChainFile = {
      version: 1,
      config: this.config,
      master: this.master,
      columns: { ...this.columns },
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
      });
      for (const item of plan) {
        await this.dispatchOne(config, snap.columns, item.workingPhase, item.card, snap);
      }
    } catch (error) {
      this.deps.log(`dispatch pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.passing = false;
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
      this.deps.log(
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
        this.deps.log(
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
      this.deps.log(`dispatch skips ${card.id}: the ticket file is unreadable`);
      return;
    }
    const composed = composeRunRequest({
      card,
      ticketText: text,
      vaultPath: config.ticketsVaultPath,
      workingPhase,
      nextPhaseId,
      nextPhaseClaims,
      repo,
      promptText,
      defaultWorker: config.defaultWorker,
      permissionMode: config.permissionMode,
      gitPath: config.git,
      workerChoice: null,
      dispatchedBy: workingPhaseId,
    });
    if (!composed.ok) {
      this.deps.log(`dispatch skips ${card.id}: ${composed.error}`);
      return;
    }
    const outcome = await this.deps.supervisorOf(composed.request.provider).start(composed.request);
    if (outcome.ok) {
      this.deps.log(
        `dispatched ${card.id} (${workingPhaseId} pool, ${composed.request.provider}` +
          `${composed.request.model !== null ? `/${composed.request.model}` : ''}) as ${outcome.run.id}`,
      );
    } else {
      this.deps.log(`dispatch refused ${card.id}: ${outcome.error}`);
    }
  }
}

/** Assembles the board the same way Drey does — from the vault's files. */
export async function readVaultBoard(vaultPath: string, defaultWorker: string): Promise<BoardSnapshot> {
  const ticketsDir = path.join(vaultPath, 'tickets');
  const entries = await fsp.readdir(ticketsDir, { withFileTypes: true }).catch(() => []);
  const files: BoardFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '_meta') {
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
