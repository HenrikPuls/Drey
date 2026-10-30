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
   * How the run's context should reach the worker (T-0049): `'auto'`
   * lets the supervisor resolve it from the ticket's run history, an
   * explicit mode is honoured when structurally legal. Absent — every
   * request from an older plugin — means `'fresh'`.
   */
  readonly handover?: HandoverMode | 'auto';
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

// ---------------------------------------------------------------------------
// Token telemetry (T-0048): what a provider reported one run used. A
// counter is `null` when the provider never reported it — 0 is a
// measurement, absence is not (the pinned plan provider may report no
// cache fields at all).

export interface RunUsage {
  readonly input: number | null;
  readonly cacheRead: number | null;
  readonly cacheCreation: number | null;
  readonly output: number | null;
}

/**
 * How the run's context reached the worker (T-0049): `'fresh'` — a new
 * session with the composed instruction (the T-0048 behaviour);
 * `'resume'` — the previous run's provider session, continued;
 * `'resume-compact'` — the same, natively compacted before the first
 * prompt. `'fresh'` is the default everywhere an older sender omits it.
 */
export type HandoverMode = 'fresh' | 'resume' | 'resume-compact';

/** The handover thresholds (T-0049); configurable `fleet.*`. */
export interface FleetHandoverConfig {
  /**
   * A resumed session whose last known context is at or above this many
   * tokens is compacted first (provider capability permitting). The bar
   * guards fidelity loss, not tokens — the compact itself is cheap
   * (spike 2: ~0.75k tokens halving an 8k context). Provisional.
   */
  readonly compactAboveTokens: number;
  /**
   * Per-provider and per-model thresholds over the base, keyed
   * `<workerProvider>` or `<workerProvider>/<modelPin>` — the
   * most-specific key wins at resolution. No UI: a hand-edited power
   * knob (`fleet.compactAboveTokens.<key>` flat keys plugin-side).
   */
  readonly compactAboveTokensOverrides?: Readonly<Record<string, number>>;
  /**
   * A pause shorter than this many minutes counts as warm (spike 3: a
   * resumed turn re-pays the transcript as cache reads, still ~99 %
   * cached after 6 min; measured auto-retry gaps ran 1–13 min).
   */
  readonly resumePauseTtlMin: number;
}

/** The handover thresholds' defaults — an absent or invalid config degrades to these. */
export const DEFAULT_FLEET_HANDOVER: FleetHandoverConfig = {
  compactAboveTokens: 60_000,
  resumePauseTtlMin: 15,
};

/** Resolves handover thresholds of unknown shape to valid ones, per key
 *  like the caps: every non-negative finite number wins, anything else
 *  falls back to that key's default (an invalid override entry drops). */
export function normalizeFleetHandover(value: unknown): FleetHandoverConfig {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const num = (key: 'compactAboveTokens' | 'resumePauseTtlMin'): number => {
    const given = raw[key];
    return typeof given === 'number' && Number.isFinite(given) && given >= 0 ? given : DEFAULT_FLEET_HANDOVER[key];
  };
  const overridesRaw = raw['compactAboveTokensOverrides'];
  const overrides: Record<string, number> = {};
  if (typeof overridesRaw === 'object' && overridesRaw !== null) {
    for (const [key, given] of Object.entries(overridesRaw as Record<string, unknown>)) {
      if (typeof given === 'number' && Number.isFinite(given) && given >= 0) {
        overrides[key] = given;
      }
    }
  }
  return {
    compactAboveTokens: num('compactAboveTokens'),
    ...(Object.keys(overrides).length > 0 ? { compactAboveTokensOverrides: overrides } : {}),
    resumePauseTtlMin: num('resumePauseTtlMin'),
  };
}

/** The output caps an instruction applies (T-0048); configurable `fleet.cap.*`. */
export interface FleetCaps {
  /** The gate failure's tail, injected into a retry's instruction. */
  readonly gateFailureLines: number;
  readonly gateFailureBytes: number;
  /** The worktree diff stat's head, injected into every instruction. */
  readonly diffStatLines: number;
  readonly diffStatBytes: number;
}

/** The caps' defaults — an absent or invalid config degrades to these. */
export const DEFAULT_FLEET_CAPS: FleetCaps = {
  gateFailureLines: 40,
  gateFailureBytes: 4096,
  diffStatLines: 50,
  diffStatBytes: 4096,
};

/** Resolves a caps value of unknown shape (wire body, plugin config) to
 *  a valid one: every non-negative finite number wins per key, anything
 *  else falls back to the default of that key. */
export function normalizeFleetCaps(value: unknown): FleetCaps {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const num = (key: keyof FleetCaps): number => {
    const given = raw[key];
    return typeof given === 'number' && Number.isFinite(given) && given >= 0 ? given : DEFAULT_FLEET_CAPS[key];
  };
  return {
    gateFailureLines: num('gateFailureLines'),
    gateFailureBytes: num('gateFailureBytes'),
    diffStatLines: num('diffStatLines'),
    diffStatBytes: num('diffStatBytes'),
  };
}

/**
 * One worker provider's pool (req-63): how many runs of that provider
 * the machine carries at once, across every column. Configurable
 * `fleet.pool.<provider>.size` / `.probe`.
 */
export interface FleetPool {
  /** Parallel runs (≥ 1). */
  readonly size: number;
  /**
   * An OpenAI-compatible llama.cpp server's base URL: its `/props`
   * `total_slots` caps `size` (the only local server that reports its
   * parallelism). Null = no probe.
   */
  readonly probeUrl: string | null;
}

export type FleetPools = Readonly<Record<WorkerProviderId, FleetPool>>;

export const DEFAULT_FLEET_POOL: FleetPool = { size: 1, probeUrl: null };

/** Resolves pools of unknown shape (wire body, plugin config) per
 *  provider: a whole size ≥ 1 and an http(s) probe URL win, anything
 *  else falls back to the default. */
export function normalizeFleetPools(value: unknown): FleetPools {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const one = (provider: WorkerProviderId): FleetPool => {
    const entry = (typeof raw[provider] === 'object' && raw[provider] !== null ? raw[provider] : {}) as Record<
      string,
      unknown
    >;
    const size = entry['size'];
    const probe = entry['probeUrl'];
    return {
      size: typeof size === 'number' && Number.isInteger(size) && size >= 1 ? size : DEFAULT_FLEET_POOL.size,
      probeUrl: typeof probe === 'string' && /^https?:\/\/\S+$/.test(probe.trim()) ? probe.trim() : null,
    };
  };
  return { opencode: one('opencode'), 'claude-code': one('claude-code') };
}
/** One question of OpenCode's `question` tool (a field of its pending form). */
export interface WaitQuestion {
  /** The form field the answer goes to (`q0`, `q1`, …). */
  readonly key: string;
  /** The short label the worker gave the question. */
  readonly header?: string;
  readonly question: string;
  /** The choices offered; the owner may also answer in their own words. */
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  /** Several choices may be picked. */
  readonly multiple: boolean;
}

/** The owner's answer to a question form: per field key, a choice or free text (several for `multiple`). */
export type QuestionAnswers = Readonly<Record<string, string | readonly string[]>>;

/** Checks an answers payload off the wire; null when it is not one. */
export function questionAnswersOf(raw: unknown): QuestionAnswers | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const answers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      answers[key] = value;
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      answers[key] = value as string[];
    } else {
      return null;
    }
  }
  return answers;
}

/**
 * What a live worker waits on the owner for (req-64): a question it ended
 * its turn with (`QUESTION: …`) or asked with OpenCode's `question` tool,
 * or a tool call the provider wants approved (OpenCode's permission
 * requests). The run stays up, its session and context kept, until the
 * owner answers.
 */
export interface RunWaiting {
  readonly kind: 'question' | 'permission';
  /** The question, or what the tool wants to do (action and resources). */
  readonly text: string;
  /** When the wait began (ISO). */
  readonly since: string;
  /** The provider's id of the permission request or question form — what the answer names. */
  readonly requestId?: string;
  /** The questions of a question form, with their choices (absent for a `QUESTION:` turn). */
  readonly questions?: readonly WaitQuestion[];
}

/**
 * The lead-in a worker opens its last message with when it cannot go on
 * without the owner (req-64). The turn then does not end the run: the
 * worker stands, waiting, until the owner answers in the takeover tab.
 */
export const QUESTION_MARKER = 'QUESTION:';

/** The owner's answer to a permission request (OpenCode's three replies). */
export type PermissionDecision = 'once' | 'always' | 'reject';

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
  /** What the worker waits on the owner for (req-64); null/absent = nothing. */
  readonly waiting?: RunWaiting | null;
  /**
   * Working time already accumulated, in milliseconds — the busy spans
   * the runner closed (the turn went idle or a wait began). The elapsed
   * clocks (req-67) add the open span to it instead of running on the
   * wall clock, so waits for the owner and standing workers do not tick.
   * Absent on run.json records written before req-67 — readers fall back
   * to the wall clock since the start.
   */
  readonly execMs?: number;
  /**
   * When the run's open working span began (ISO); null while it stands.
   * Undefined (together with execMs) on pre-req-67 records; a run whose
   * provider reports no turn never carries either.
   */
  readonly execSince?: string | null;
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
  /** The machine gate's verdict, once it ran (T-0048); absent when it never did. */
  readonly gateResult?: 'green' | 'red' | null;
  /** The worker's last error event (req-63: a rate limit shrinks the pool). */
  readonly lastError?: string | null;
  // --- token telemetry (T-0048); all optional so adopt() restores older
  // --- records — every reader treats absent as unknown.
  /** The model pin the run started with (`provider/model` or bare). */
  readonly model?: string | null;
  /** The phase the ticket sat in when the run started. */
  readonly phase?: string | null;
  /** Usage summed over the run's model calls; a null counter was never reported. */
  readonly usage?: RunUsage;
  /**
   * The input side (input + cacheRead + cacheCreation) of the LAST
   * assistant turn — the real context size, unlike the providers'
   * cumulative aggregates.
   */
  readonly lastTurnContext?: number | null;
  /** How many model calls reported usage. */
  readonly turns?: number;
  /** Read/grep/glob tool calls — the exploration counter. */
  readonly readCalls?: number;
  /**
   * Input-side tokens over the turns before the first write/edit tool
   * call; the full input side when no write came; null without any usage.
   */
  readonly tokensBeforeFirstWrite?: number | null;
  /** Always 'fresh' in T-0048; the field exists for T-0049's handover modes. */
  readonly handoverMode?: HandoverMode;
  /**
   * The provider session this run resumed (T-0049) — taken from the
   * candidate record, never the init event (a forked id would lose the
   * lineage). Null on a fresh run and on a resume that fell back fresh.
   */
  readonly resumedFrom?: string | null;
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
  /** The instruction output caps (T-0048); absent = `DEFAULT_FLEET_CAPS`. */
  readonly caps?: FleetCaps;
  /** The per-provider pools (req-63); absent = one run per provider. */
  readonly pools?: FleetPools;
  /** The handover thresholds (T-0049); absent = `DEFAULT_FLEET_HANDOVER`. */
  readonly handover?: FleetHandoverConfig;
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
