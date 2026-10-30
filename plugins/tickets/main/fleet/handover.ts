/**
 * The fleet's session handover (T-0049, ADR-0075 later change): the
 * pure rules that decide how a run's context reaches its worker — a
 * fresh instruction, the previous run's provider session resumed, or
 * the same natively compacted before the first prompt.
 *
 * Pure on purpose: the supervisor (which holds every run record) and
 * the start dialog (which holds the fleet snapshot) run the SAME rules
 * — the dialog can only disable what these rules call illegal, it can
 * never promise a mode the start would silently switch away. Measured
 * basis: the opencode compact endpoint's shape and effect (spike 2),
 * the resume cost curve with its warm-cache window (spike 3) — see the
 * T-0049 Log.
 *
 * No Node imports: the renderer bundles this module (COMPACT_CAPABILITY
 * and the types); `providers.ts` re-exports the capability table so the
 * main side reads one table too.
 */
import type { FleetHandoverConfig, HandoverMode, RunState, WorkerProviderId } from './protocol';

/**
 * Which providers can compact a session natively (T-0049):
 * - opencode: `POST /api/session/{id}/compact` — measured (spike 2):
 *   200, a `compaction` message, the context halved, ~0.75k tokens.
 * - claude-code: `'none'` for now — spike 1 proved `/compact` routes
 *   natively as a stream-json user message, but its OAuth was expired,
 *   so no effect was observed. One-line flip once verified.
 */
export const COMPACT_CAPABILITY: Readonly<Record<WorkerProviderId, 'native' | 'none'>> = {
  opencode: 'native',
  'claude-code': 'none',
};

/** The run a handover could resume — the newest terminal record of the
 *  same ticket, mapped by the caller (supervisor or board snapshot). */
export interface HandoverCandidate {
  /** The phase the candidate's ticket sat in when it started. */
  readonly phase: string;
  readonly provider: string;
  readonly model: string | null;
  /** Terminal states are candidates — the retry case IS a failed run; `detached` is not (its worker may still live). */
  readonly state: RunState;
  readonly sessionRef: string | null;
  /** The candidate's last assistant turn's input side; null = unknown (every pre-T-0048 record). */
  readonly lastTurnContext: number | null;
  readonly endedAt: string | null;
}

export interface HandoverInput {
  /** What was asked: an explicit mode from the dialog, `'auto'` from the dispatcher. */
  readonly requested: HandoverMode | 'auto';
  /** The phase the new run works — `review` always resolves fresh (independence). */
  readonly phase: string;
  /** The newest terminal record of THIS ticket; null when there is none. */
  readonly candidate: HandoverCandidate | null;
  readonly provider: string;
  readonly model: string | null;
  /** The worktree was recreated or moved aside (T-0047 flag) — prior session context is stale. */
  readonly sessionInvalidated: boolean;
  /** A non-terminal run in this supervisor holds the candidate's session (double-resume hazard). */
  readonly sessionInUse: boolean;
  readonly capability: 'native' | 'none';
  readonly config: FleetHandoverConfig;
  readonly nowMs: number;
}

export interface HandoverDecision {
  readonly mode: HandoverMode;
  /** The session to resume; null on fresh. */
  readonly resumeRef: string | null;
  /** Compact the resumed session before the first prompt (adapter-level flag). */
  readonly compactFirst: boolean;
  /** One line — the stream note and the runner log carry it. */
  readonly why: string;
}

/** The terminal states that may carry a resumable session. */
export const HANDOVER_CANDIDATE_STATES: readonly RunState[] = ['done', 'stopped', 'failed'];

/**
 * Resolves the handover mode. Rules (auto path; explicit requests are
 * honoured when structurally legal, never silently switched to a
 * different resume mode):
 *
 * - `review` → fresh, always — a fresh worker keeps the review independent.
 * - no candidate / no session / other provider or model / candidate
 *   phase ≠ run phase (build after plan) / invalidated or in-use
 *   session → fresh.
 * - warm pause (within `resumePauseTtlMin`) → resume — the transcript
 *   re-pays as cache reads (spike 3), whatever its size.
 * - known context below `compactAboveTokens` → resume — the re-pay is
 *   bounded, the fidelity loss is not.
 * - context at or above the threshold and a cold pause →
 *   `resume-compact` when the provider compacts natively, else fresh.
 * - unknown context (a pre-T-0048 record) and a cold pause → fresh —
 *   never auto-compact a transcript nobody measured.
 */
export function resolveHandover(input: HandoverInput): HandoverDecision {
  const fresh = (why: string): HandoverDecision => ({ mode: 'fresh', resumeRef: null, compactFirst: false, why });
  const resume = (sessionRef: string, why: string): HandoverDecision => ({
    mode: 'resume',
    resumeRef: sessionRef,
    compactFirst: false,
    why,
  });

  if (input.phase === 'review') {
    return fresh('the review phase always starts fresh — an independent worker judges the step');
  }
  if (input.requested === 'fresh') {
    return fresh('explicit fresh start');
  }
  const candidate = input.candidate;
  if (candidate === null) {
    return fresh('no earlier run of this ticket to resume');
  }
  if (!HANDOVER_CANDIDATE_STATES.includes(candidate.state)) {
    return fresh(`the last run is ${candidate.state} — only a settled run leaves a resumable session`);
  }
  if (candidate.sessionRef === null) {
    return fresh('the last run reported no session');
  }
  if (candidate.provider !== input.provider || candidate.model !== input.model) {
    return fresh(
      `the last session ran ${candidate.provider}${candidate.model !== null ? `/${candidate.model}` : ''}` +
        ` — this run is ${input.provider}${input.model !== null ? `/${input.model}` : ''}`,
    );
  }
  if (candidate.phase !== input.phase) {
    return fresh(`the last session worked the ${candidate.phase} phase — this run starts ${input.phase} fresh`);
  }
  if (input.sessionInvalidated) {
    return fresh('the worktree was recreated or moved aside — the session\'s file state is stale');
  }
  if (input.sessionInUse) {
    return fresh('another run holds that session — resuming it twice is refused');
  }

  // From here a resume is structurally legal; an explicit ask is honoured.
  if (input.requested === 'resume') {
    return resume(candidate.sessionRef, 'explicit resume of the last session');
  }
  if (input.requested === 'resume-compact') {
    if (input.capability !== 'native') {
      return fresh(`the ${input.provider} worker cannot compact natively`);
    }
    return {
      mode: 'resume-compact',
      resumeRef: candidate.sessionRef,
      compactFirst: true,
      why: 'explicit resume with a native compact first',
    };
  }

  // The auto path — the measured rules.
  const pauseMs =
    candidate.endedAt !== null && Number.isFinite(Date.parse(candidate.endedAt))
      ? input.nowMs - Date.parse(candidate.endedAt)
      : Number.POSITIVE_INFINITY;
  const warmMs = input.config.resumePauseTtlMin * 60_000;
  const context = candidate.lastTurnContext;
  if (pauseMs < warmMs) {
    return resume(
      candidate.sessionRef,
      context !== null
        ? `pause ${Math.max(0, Math.round(pauseMs / 60_000))} min is within the cache TTL — the transcript re-pays cached (ctx ${context})`
        : `pause ${Math.max(0, Math.round(pauseMs / 60_000))} min is within the cache TTL — the transcript re-pays cached`,
    );
  }
  if (context !== null && context < input.config.compactAboveTokens) {
    return resume(
      candidate.sessionRef,
      `cold pause, but the context (${context}) is below the compact threshold — resumed as it is`,
    );
  }
  if (context !== null && context >= input.config.compactAboveTokens && input.capability === 'native') {
    return {
      mode: 'resume-compact',
      resumeRef: candidate.sessionRef,
      compactFirst: true,
      why: `cold pause with a ${context}-token context — resumed and natively compacted first`,
    };
  }
  return fresh(
    context === null
      ? 'cold pause and the last context is unknown — never auto-compact an unmeasured transcript'
      : `cold pause with a ${context}-token context and no native compact — fresh is cheaper`,
  );
}
