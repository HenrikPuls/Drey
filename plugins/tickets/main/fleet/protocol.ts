/**
 * The fleet runner's wire protocol (ADR-0075, milestone 84): the shapes
 * the tickets plugin's main side exchanges with the standalone runner
 * over its loopback HTTP surface — and the runner's normalized run
 * record, which doubles as `run.json` on disk.
 *
 * The runner is a plain Node process (spawned detached with
 * ELECTRON_RUN_AS_NODE from the plugin bundle's sibling file): it never
 * imports Electron, and everything crossing this file must stay
 * JSON-serializable. The instruction text is composed plugin-side (the
 * vault is where prompts and ticket context live); the runner owns the
 * worker process, its pipes, the worktree and the machine gate.
 */

/** The workers of milestone 84, in fleet order (the assignment default). */
export type WorkerProviderId = 'opencode' | 'claude-code';

export const WORKER_PROVIDERS: readonly WorkerProviderId[] = ['opencode', 'claude-code'];

export function isWorkerProvider(value: unknown): value is WorkerProviderId {
  return typeof value === 'string' && (WORKER_PROVIDERS as readonly string[]).includes(value);
}

/** How the runner may let the agent answer itself (blast radius; ADR-0075). */
export type PermissionMode = 'accept-edits' | 'bypass';

/**
 * What the runner needs to start one run. One run = one ticket = one
 * worktree on the deterministic branch (ADR-0075); the ticket-file
 * context rides along because the runner composes the instruction and
 * runs the machine gate in the worker's checkout.
 */
export interface RunRequest {
  /** The ticket this run works on (schema id = filename stem). */
  readonly ticketId: string;
  /** Absolute path of the tickets vault (the runner edits the file there). */
  readonly ticketsVaultPath: string;
  /** Vault-relative path of the ticket file (`tickets/<phase>/<id>.md`). */
  readonly ticketRelPath: string;
  /** The phase the ticket sits in now (the runner moves it on success). */
  readonly phase: string;
  /** Absolute path of the work repo's checkout. */
  readonly repoPath: string;
  /**
   * The run's worktree, absolute (`<ticketsRepo>/_worktrees/<ticket-id>`
   * by default, ADR-0080). Computed in `composeRunRequest` — the runner
   * never derives paths; an old sender without the field is refused.
   */
  readonly worktreePath: string;
  /** The deterministic branch — `t/<id>` (ADR-0076). */
  readonly branch: string;
  /** The base ref a fresh worktree branches from (repos.md `branch:` or HEAD). */
  readonly baseRef: string | null;
  /**
   * Git-ignored folders of `repoPath` the worktree links instead of
   * rebuilding (repos.md `link:`, req-56) — the toolchain a worker would
   * otherwise hunt for. Absent on requests from before it existed.
   */
  readonly links?: readonly string[];
  readonly provider: WorkerProviderId;
  readonly permissionMode: PermissionMode;
  /** Provider model pin, when the assignment names one (`worker@provider/model`). */
  readonly model: string | null;
  /** The composed instruction (prompt template + ticket context, plugin-side). */
  readonly instruction: string;
  /** The machine gate: the ticket's backticked acceptance commands, in order. */
  readonly acceptance: readonly string[];
  /**
   * `commands` runs the acceptance commands (the normal gate).
   * `structural` is the plan phase's gate: the ticket entered without
   * executable criteria (writing them is the plan's job), so the gate
   * instead checks that the run produced at least one.
   */
  readonly gate: 'commands' | 'structural';
  /** Git executable for worktree + ticket commits (the plugin's gitPath or `git`). */
  readonly git: string;
  /** Transition target after a green gate — the pipeline's next phase id. */
  readonly nextPhase: string | null;
  /** Resolved directory name for `nextPhase` (numbered `NN-<id>` folders,
   *  T-0041); null exactly when `nextPhase` is null. Older stored records
   *  predate it — readers fall back to the phase id. */
  readonly nextPhaseDir: string | null;
  /** pipeline.md `push:` — the remote the transition commit is pushed to
   *  after a green move (T-0041); null = never push. */
  readonly pushRemote: string | null;
  /** Next phase claims (claim: true) → stamped with this identity. */
  readonly claimIdentity: string | null;
  /** The dialog's explicit worker choice, recorded on the ticket (`worker:`). */
  readonly recordWorker?: string;
  /**
   * The working column when the orchestrator dispatched the run (M85,
   * ADR-0077): the pool whose slot the run occupies — which can differ
   * from `phase`, because a pool tops up from the previous column (the
   * ticket then still sits in that column while the run works it).
   * Null on an owner-started run.
   */
  readonly column?: string | null;
}

/** How the run's worktree was obtained — `prepareWorktree` (T-0047) is
 *  idempotent per ticket, so a repeated run reports what it did. */
export type WorktreeOutcome = 'reused' | 'created' | 'recreated' | 'moved-aside';

/** A run as the runner reports it — and as `run.json` persists it. */
export interface RunInfo {
  readonly id: string;
  readonly ticketId: string;
  readonly provider: WorkerProviderId;
  readonly state: RunState;
  readonly pid: number | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** The provider session to resume/steer with, once known. */
  readonly sessionRef: string | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /**
   * The part of `tokensIn` served from the provider's prompt cache
   * (req-53) — absent on a run.json written before it was recorded.
   */
  readonly cacheReadTokens?: number;
  readonly costUsd: number | null;
  readonly lastActivity: string;
  /**
   * What the worker is doing right now, in one short line (the last
   * tool call or the first line of its last text) — the board's lane
   * shows it. Absent on a run.json written before the lanes existed.
   */
  readonly activity?: string;
  /**
   * The size of the worker's current context window in tokens (the
   * last model call's input incl. cache reads); null/absent while the
   * provider has reported none.
   */
  readonly contextTokens?: number | null;
  /**
   * The model's context window in tokens — the limit the board measures
   * `contextTokens` against. Null/absent while the provider has
   * reported none (the board then measures against its default window);
   * absent on run.json records written before the field existed.
   */
  readonly contextWindow?: number | null;
  /**
   * The owner has taken the run over (the takeover tab): the worker's
   * finished turn does not end the run, the reaper leaves a quiet worker
   * alone, and the runner sends it nothing of its own until it is handed back.
   */
  readonly held?: boolean;
  /**
   * Whether the worker is in the middle of a turn (`busy`) or standing
   * and waiting for input (`idle`) — the board's "running or standing".
   * Absent while the provider has not said (and for providers that
   * cannot).
   */
  readonly turn?: 'busy' | 'idle';
  /**
   * The slash commands the worker accepts (names without the slash) — the
   * takeover tab's prompt box lists them. Absent until the worker reports.
   */
  readonly commands?: readonly string[];
  /** The working column whose pool owns this run (`request.column ?? request.phase`). */
  readonly column?: string | null;
  /** How many steer messages reached the worker, and how. */
  readonly steerCount: number;
  readonly lastSteerRung: SteerRung | null;
  readonly worktreePath: string;
  readonly branch: string;
  /** On every run started after T-0047; absent on adopted pre-T-0047 records. */
  readonly worktree?: WorktreeOutcome;
  /** The last gate failure, when the machine gate stopped the run short. */
  readonly gateFailure: string | null;
}

export type RunState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'done'
  | 'stopped'
  | 'failed'
  | /** the runner restarted while the worker lived on; unwatchable */ 'detached';

/** Which rung of the steer ladder a message took (ADR-0075). */
export type SteerRung = 'inject' | 'resume' | 'refused';

export interface RunListResponse {
  readonly runs: readonly RunInfo[];
}

export interface RunStartResponse {
  readonly ok: true;
  readonly run: RunInfo;
}

export interface RunErrorResponse {
  readonly ok: false;
  readonly error: string;
}

/** The runner's self-description on `<root>/runner.json` and `GET /health`. */
export interface RunnerDescriptor {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly version: number;
  /**
   * Build stamp of the entry script (its mtime at boot, ISO) — the
   * client's respawn signal when the file on disk has moved on.
   */
  readonly build?: string;
}

/** Which ticket-file stamps the runner performs itself (same semantics
 *  as Drey's board service: patch + one commit; ADR-0076 single-writer). */
export interface TicketEdit {
  readonly vaultPath: string;
  readonly relPath: string;
  readonly git: string;
}

// ---------------------------------------------------------------------------
// The chain (M85, ADR-0077): the orchestrator's configuration and control
// state. Config rides from the plugin (which owns the plugin config and
// the vault registry); master and per-column state persist runner-side in
// `<root>/chain.json` — never in the tickets repo (ADR-0076: no view
// state in the repo).

/** The master switch: `run` dispatches, `halted` lets running work finish. */
export type ChainMaster = 'run' | 'halted';

/** One column's brake: `playing` dispatches, `held` waits (a stop also holds). */
export type ColumnMode = 'playing' | 'held';

/** What the plugin tells the runner about its world (idempotent POST). */
export interface ChainConfig {
  /** Absolute path of the tickets vault to orchestrate. */
  readonly ticketsVaultPath: string;
  /** Git executable for ticket commits (the plugin's gitPath or `git`). */
  readonly git: string;
  /** The plugin's configured default worker (the assignment ring's floor). */
  readonly defaultWorker: string;
  /** Permission mode of dispatched runs (no dialog to ask in). */
  readonly permissionMode: PermissionMode;
}

/** The chain's control state as the runner reports it. */
export interface ChainStatus {
  /** True once a chain config is set (the board shows the master switch). */
  readonly configured: boolean;
  readonly master: ChainMaster;
  /** Per working column mode; a phase absent here is `playing`. */
  readonly columns: Readonly<Record<string, ColumnMode>>;
  /** Consecutive red gates per column (the circuit breaker's counter). */
  readonly redStreak: Readonly<Record<string, number>>;
  /** Columns in cooldown — the ISO instant dispatching resumes after a red gate. */
  readonly cooldownUntil: Readonly<Record<string, string>>;
}
