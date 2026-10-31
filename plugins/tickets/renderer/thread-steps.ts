/**
 * The ticket thread's steps (req-75 W4a, ADR-0087 decision 3): one step
 * per run of the ticket — a run is one phase of the ticket, so the
 * conversation shows earlier runs as one folded line each and the live
 * (or newest) run open at the bottom. Pure: `mountThreadOf` draws it.
 */
import type { RunInfo } from '../main/fleet/protocol';
import { execClockMs } from './worker-status';

/** The states a run can be watched in; `detached` is unwatchable but alive. */
const LIVE_STATES: readonly string[] = ['starting', 'running', 'stopping', 'detached'];

export interface ThreadStep {
  readonly runId: string;
  readonly live: boolean;
  /**
   * `Planned`, `Built`, `Merged`, `Reviewed`, else the phase id
   * capitalised; live: `Planning`, `Building`, `Merging`,
   * `Waiting for you`, `Idle`.
   */
  readonly label: string;
  /** e.g. `6 min` (execMs, else end − start). */
  readonly duration: string;
  /** ✓ done with a green gate, ✕ failed / red gate, ■ stopped, ● live. */
  readonly mark: '✓' | '✕' | '■' | '●';
  /** Gate failure first line, or null. */
  readonly detail: string | null;
}

/** What one phase id's run did — the past-tense step words (canvas "3a"). */
const DONE_LABEL: Readonly<Record<string, string>> = {
  plan: 'Planned',
  build: 'Built',
  commit: 'Merged',
  review: 'Reviewed',
};

/** What a live run is doing — the -ing words of the same phases. */
const LIVE_LABEL: Readonly<Record<string, string>> = {
  plan: 'Planning',
  build: 'Building',
  commit: 'Merging',
};

const capitalize = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

const phaseOf = (run: RunInfo): string | null => {
  const phase = run.phase ?? null;
  return phase === null || phase.trim() === '' ? null : phase;
};

const doneLabel = (run: RunInfo): string => {
  const phase = phaseOf(run);
  if (phase !== null && DONE_LABEL[phase] !== undefined) {
    return DONE_LABEL[phase]!;
  }
  return phase !== null ? capitalize(phase) : capitalize(run.state);
};

const liveLabel = (run: RunInfo): string => {
  if (run.waiting != null) {
    return 'Waiting for you';
  }
  if (run.turn === 'idle') {
    return 'Idle';
  }
  const phase = phaseOf(run);
  if (phase !== null && LIVE_LABEL[phase] !== undefined) {
    return LIVE_LABEL[phase]!;
  }
  return phase !== null ? capitalize(phase) : 'Working';
};

/** A duration as `42 s`, `6 min`, `3 h` — whole steps, never 1 decimal of a run. */
export function durationWords(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) {
    return `${total} s`;
  }
  if (total < 3_600) {
    return `${Math.floor(total / 60)} min`;
  }
  return `${Math.floor(total / 3_600)} h`;
}

/** The step's clock: the run's working time while it lives, else execMs or end − start. */
const stepMs = (run: RunInfo, nowMs: number): number => {
  if (run.execMs !== undefined) {
    return execClockMs(run, nowMs);
  }
  const started = Date.parse(run.startedAt);
  const ended = run.endedAt === null || run.endedAt === undefined ? NaN : Date.parse(run.endedAt);
  if (!Number.isNaN(started) && !Number.isNaN(ended)) {
    return Math.max(0, ended - started);
  }
  return execClockMs(run, nowMs);
};

const markOf = (run: RunInfo): ThreadStep['mark'] => {
  if (LIVE_STATES.includes(run.state)) {
    return '●';
  }
  if (run.state === 'failed' || run.gateResult === 'red') {
    return '✕';
  }
  if (run.state === 'stopped') {
    return '■';
  }
  return '✓';
};

const detailOf = (run: RunInfo): string | null => {
  const failure = run.gateFailure ?? null;
  if (failure === null || failure.trim() === '') {
    return null;
  }
  const first = failure.split('\n').find((line) => line.trim() !== '') ?? '';
  const text = first.trim();
  return text === '' ? null : text;
};

const stepOf = (run: RunInfo, nowMs: number): ThreadStep => {
  const live = LIVE_STATES.includes(run.state);
  return {
    runId: run.id,
    live,
    label: live ? liveLabel(run) : doneLabel(run),
    duration: durationWords(stepMs(run, nowMs)),
    mark: markOf(run),
    detail: detailOf(run),
  };
};

/** Runs of one ticket, oldest first (startedAt, then id for a stable tie). */
export function threadSteps(ticketId: string, runs: readonly RunInfo[], nowMs: number): readonly ThreadStep[] {
  return runs
    .filter((run) => run.ticketId === ticketId)
    .sort((a, b) => (a.startedAt === b.startedAt ? a.id.localeCompare(b.id) : a.startedAt.localeCompare(b.startedAt)))
    .map((run) => stepOf(run, nowMs));
}

/**
 * The header's state word for the live run: `Waiting for you` (waiting),
 * `Planning`/`Building`/`Merging` by phase id, `Idle` when turn idle;
 * null without a live run. A detached run reads as `Running` — never
 * the word "detached"; the meta line says why (`not connected`).
 */
export function liveStateWord(run: RunInfo | null): string | null {
  if (run === null || !LIVE_STATES.includes(run.state)) {
    return null;
  }
  return run.state === 'detached' ? 'Running' : liveLabel(run);
}

/** The header's buttons, in the order the header shows them. */
export type HeaderControl = 'pause' | 'takeover' | 'handback' | 'stop' | 'resume' | 'start';

/**
 * The header's controls for the ticket's newest run (owner request
 * 2026-10-31: one ticket, one session, the same controls in every
 * state — exactly one way on): Stop for any run not ended, with
 * Pause/Take over beside it only while the worker is connected (a
 * detached run gets Resume session instead, its session is all that
 * is left to talk to); an ended run with a session shows Resume
 * session; no run, or an ended run without one, shows Start.
 */
export function headerControls(run: RunInfo | null): readonly HeaderControl[] {
  if (run === null) {
    return ['start'];
  }
  if (run.state === 'detached') {
    return run.sessionRef !== null ? ['stop', 'resume'] : ['stop'];
  }
  if (LIVE_STATES.includes(run.state)) {
    const controls: HeaderControl[] = ['pause', 'takeover', 'stop'];
    if (run.held === true) {
      controls.push('handback');
    }
    return controls;
  }
  return run.sessionRef !== null ? ['resume'] : ['start'];
}
