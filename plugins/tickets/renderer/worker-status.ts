/**
 * The pure half of the board's worker lanes: how a live run's numbers
 * become a traffic light, a context fill and the short texts the lane
 * shows. No DOM — the board draws it (index.ts), the spec pins it.
 */
import type { RunInfo } from '../main/fleet/protocol';
import type { ChainAlert } from './chain-alerts';

/**
 * The window the context bar falls back to when the worker reported
 * none (opencode's own catalog-less default is the same 200k —
 * coincidence, not coupling). The real window rides the run as
 * `RunInfo.contextWindow` (T-0052).
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** No output for this long on a running worker is a stall (red). */
export const STALL_MS = 5 * 60_000;

/** A context fill from here on warns (amber). */
export const CONTEXT_WARN = 0.8;

/** `idle` (gray) is a worker that stands: no turn in progress, waiting for input. */
export type Light = 'green' | 'amber' | 'red' | 'idle';

export interface WorkerStatus {
  readonly light: Light;
  /** The state as words — a light is never the only cue. */
  readonly label: string;
}

/** The share of the model's context window in use, 0..1; null while no context size is known. */
export function contextFill(run: RunInfo): number | null {
  const used = run.contextTokens;
  const windowTokens = run.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (used === undefined || used === null || windowTokens <= 0) {
    return null;
  }
  return Math.min(1, used / windowTokens);
}

/**
 * The lane's context row: `Context used / window · fill%` against the
 * reported window (the 200k fallback when none was), or the hint while
 * the worker has reported no context size at all.
 */
export function contextLabel(run: RunInfo): string {
  const used = run.contextTokens;
  if (used === undefined || used === null) {
    return 'Context — not reported yet';
  }
  const windowTokens = run.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return `Context ${formatTokens(used)} / ${formatTokens(windowTokens)} · ${Math.round((contextFill(run) ?? 0) * 100)}%`;
}

/** Traffic light of one live run: stalled beats a full context beats fine. */
export function workerStatus(run: RunInfo, nowMs: number): WorkerStatus {
  if (run.state === 'detached') {
    return { light: 'amber', label: 'Detached' };
  }
  // A worker that waits on the owner (req-64) needs a look — never a stall.
  if ((run.state === 'running' || run.state === 'starting') && run.waiting) {
    return { light: 'amber', label: run.waiting.kind === 'question' ? 'Waits for your answer' : 'Waits for your approval' };
  }
  // A worker that stands (no turn in progress) is neither working nor stalled.
  if (run.state === 'running' && run.turn === 'idle') {
    return { light: 'idle', label: run.held === true ? 'Standing — you drive' : 'Standing' };
  }
  const silentMs = nowMs - (Date.parse(run.lastActivity) || nowMs);
  if (run.state === 'running' && silentMs >= STALL_MS) {
    return { light: 'red', label: `Stalled ${Math.floor(silentMs / 60_000)}m` };
  }
  if (run.state === 'stopping') {
    return { light: 'amber', label: 'Stopping' };
  }
  const fill = contextFill(run);
  if (fill !== null && fill >= CONTEXT_WARN) {
    return { light: 'amber', label: 'Context full' };
  }
  if (run.state === 'starting') {
    return { light: 'green', label: 'Starting' };
  }
  return { light: 'green', label: run.turn === 'busy' ? 'Running' : 'Working' };
}

/** The whole fleet in one line (req-60): the panel header's status group. */
export interface FleetSummary {
  /** The worst light of all live runs: red beats amber beats green beats idle. */
  readonly light: Light;
  /** The non-zero states as words: `2 running · 1 stalled`. */
  readonly label: string;
  /** Tokens in + out of every live run. */
  readonly tokens: number;
  /** How long the oldest live run has been at it; null when no start is known. */
  readonly ageMs: number | null;
}

const LIGHT_RANK: readonly Light[] = ['idle', 'green', 'amber', 'red'];

const LIGHT_WORDS: ReadonlyArray<readonly [Light, string]> = [
  ['green', 'running'],
  ['idle', 'standing'],
  ['amber', 'need attention'],
  ['red', 'stalled'],
];

/** The live runs as the header's summary; null when none runs. */
export function fleetSummary(runs: readonly RunInfo[], nowMs: number): FleetSummary | null {
  if (runs.length === 0) {
    return null;
  }
  const lights = runs.map((run) => workerStatus(run, nowMs).light);
  const light = lights.reduce((worst, l) => (LIGHT_RANK.indexOf(l) > LIGHT_RANK.indexOf(worst) ? l : worst), 'idle' as Light);
  const label = LIGHT_WORDS.map(([l, word]) => [lights.filter((x) => x === l).length, word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ');
  const starts = runs.map((r) => Date.parse(r.startedAt)).filter((ts) => !Number.isNaN(ts));
  return {
    light,
    label,
    tokens: runs.reduce((sum, r) => sum + r.tokensIn + r.tokensOut, 0),
    ageMs: starts.length === 0 ? null : Math.max(0, nowMs - Math.min(...starts)),
  };
}

/** 1234 -> `1.2k`, 3_400_000 -> `3.4M`; small numbers stay whole. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return n >= 100_000 ? `${Math.round(n / 1_000)}k` : `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

/** The fleet's worker providers as people read them (the run modal lists the same). */
export const WORKER_LABEL: ReadonlyArray<readonly [string, string]> = [
  ['opencode', 'OpenCode'],
  ['claude-code', 'Claude Code'],
];

/** A provider id as its label (`opencode` → `OpenCode`); unknown ids stay as they are. */
export function workerLabelOf(provider: string): string {
  for (const [value, label] of WORKER_LABEL) {
    if (value === provider) {
      return label;
    }
  }
  return provider;
}

/**
 * The footer's fleet line (T-0086): the one place the fleet's status
 * lives, at every width — the summary's states in words plus who is out
 * there, tokens in flight and the oldest run's age as a mono suffix,
 * the long form for the tooltip. A standing chain alert turns the light
 * amber at least; with nothing running the alert itself is the line.
 */
export interface FleetLine {
  /** The worst light of the live runs; a standing alert turns it amber at least. */
  readonly light: Light;
  /** The visible line: `2 running · OpenCode 2`, `No workers running`, or the alert's title. */
  readonly text: string;
  /** The mono suffix `1.2M tok · 12:34`; '' when nothing runs. */
  readonly numbers: string;
  /** Tooltip and aria-label: the parts below, joined with newlines, each only when it applies. */
  readonly long: string;
}

export function fleetLine(runs: readonly RunInfo[], alerts: readonly ChainAlert[], nowMs: number): FleetLine {
  const summary = fleetSummary(runs, nowMs);
  const alertLines = alerts.map((alert) => `${alert.title}: ${alert.text}`);
  if (summary === null) {
    if (alerts.length === 0) {
      return { light: 'idle', text: 'No workers running', numbers: '', long: '' };
    }
    return {
      light: 'amber',
      text: alerts.length === 1 ? alerts[0]!.title : `${alerts.length} fleet alerts`,
      numbers: '',
      long: alertLines.join('\n'),
    };
  }
  const byProvider = new Map<string, number>();
  for (const run of runs) {
    byProvider.set(run.provider, (byProvider.get(run.provider) ?? 0) + 1);
  }
  const workers = [...byProvider].map(([provider, n]) => `${workerLabelOf(provider)} ${n}`).join(' · ');
  const age = summary.ageMs === null ? '' : spanClock(summary.ageMs);
  const dimmedByAlert = alerts.length > 0 && (summary.light === 'green' || summary.light === 'idle');
  return {
    light: dimmedByAlert ? 'amber' : summary.light,
    text: `${summary.label} · ${workers}`,
    numbers: `${formatTokens(summary.tokens)} tok${age === '' ? '' : ` · ${age}`}`,
    long: [
      summary.label,
      `${formatTokens(summary.tokens)} tokens in flight (in + out of all live runs)`,
      ...(age === '' ? [] : [`the oldest run has been at it for ${age}`]),
      ...alertLines,
    ].join('\n'),
  };
}

/**
 * The run's telemetry as the short lane/takeover chips (T-0048): context
 * of the last turn, model calls with usage, read calls. Empty while the
 * run reports nothing (also every pre-T-0048 record) — absence is not 0.
 * A resumed run (T-0049) appends the chip that says so.
 */
export function telemetryParts(run: RunInfo): readonly string[] {
  const parts: string[] = [];
  if (run.lastTurnContext !== undefined && run.lastTurnContext !== null) {
    parts.push(`ctx ${formatTokens(run.lastTurnContext)}`);
  }
  if (run.turns !== undefined && run.turns > 0) {
    parts.push(`turns ${run.turns}`);
  }
  if (run.readCalls !== undefined && run.readCalls > 0) {
    parts.push(`reads ${run.readCalls}`);
  }
  if (run.handoverMode === 'resume' || run.handoverMode === 'resume-compact') {
    parts.push('resumed');
  }
  return parts;
}

/** A duration as `mm:ss` (an hour and up rolls into `h:mm:ss`). */
export function spanClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/**
 * The run's elapsed clock (req-67): its working time — the busy spans the
 * runner closed plus the open one at `nowMs`. Waits for the owner (req-64),
 * a standing held worker and the time after the run's end do not tick.
 * A record without `execMs` (pre-req-67, or a provider that never reports
 * a turn) falls back to the wall clock since the start, clamped at the end.
 */
export function execClockMs(run: RunInfo, nowMs: number): number {
  if (run.execMs !== undefined) {
    const from = run.execSince === undefined || run.execSince === null ? NaN : Date.parse(run.execSince);
    return run.execMs + (Number.isNaN(from) ? 0 : Math.max(0, nowMs - from));
  }
  const started = Date.parse(run.startedAt);
  if (Number.isNaN(started)) {
    return 0;
  }
  const ended = run.endedAt === null || run.endedAt === undefined ? NaN : Date.parse(run.endedAt);
  return Math.max(0, (Number.isNaN(ended) ? nowMs : Math.min(nowMs, ended)) - started);
}
