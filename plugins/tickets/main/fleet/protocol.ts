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
  /** The deterministic branch — `t/<id>` (ADR-0076). */
  readonly branch: string;
  /** The base ref a fresh worktree branches from (repos.md `branch:` or HEAD). */
  readonly baseRef: string | null;
  readonly provider: WorkerProviderId;
  readonly permissionMode: PermissionMode;
  /** Provider model pin, when the assignment names one (`worker@provider/model`). */
  readonly model: string | null;
  /** The composed instruction (prompt template + ticket context, plugin-side). */
  readonly instruction: string;
  /** The machine gate: the ticket's backticked acceptance commands, in order. */
  readonly acceptance: readonly string[];
  /** Git executable for worktree + ticket commits (the plugin's gitPath or `git`). */
  readonly git: string;
  /** Transition target after a green gate — the pipeline's next phase id. */
  readonly nextPhase: string | null;
  /** Next phase claims (claim: true) → stamped with this identity. */
  readonly claimIdentity: string | null;
}

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
  readonly costUsd: number | null;
  readonly lastActivity: string;
  /** How many steer messages reached the worker, and how. */
  readonly steerCount: number;
  readonly lastSteerRung: SteerRung | null;
  readonly worktreePath: string;
  readonly branch: string;
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
}

/** Which ticket-file stamps the runner performs itself (same semantics
 *  as Drey's board service: patch + one commit; ADR-0076 single-writer). */
export interface TicketEdit {
  readonly vaultPath: string;
  readonly relPath: string;
  readonly git: string;
}
