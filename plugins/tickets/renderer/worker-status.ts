/**
 * The pure half of the board's worker lanes: how a live run's numbers
 * become a traffic light, a context fill and the short texts the lane
 * shows. No DOM — the board draws it (index.ts), the spec pins it.
 */
import type { RunInfo } from '../main/fleet/protocol';

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
 * The run chip of a ticket with a live run (T-0051):
 * `▶ running · 2 · 45k/1.2k · 03:41` — state, turns (the prompt plus
 * every steer), this run's own tokens in/out, elapsed since it started.
 * The token segment waits for the first usage event that reported any.
 */
export function runChipLine(run: RunInfo, nowMs: number): string {
  const started = Date.parse(run.startedAt);
  const elapsed = Number.isNaN(started) ? 0 : Math.max(0, nowMs - started);
  const tokens =
    run.tokensIn > 0 || run.tokensOut > 0 ? ` · ${formatTokens(run.tokensIn)}/${formatTokens(run.tokensOut)}` : '';
  return `▶ ${run.state} · ${run.steerCount + 1}${tokens} · ${spanClock(elapsed)}`;
}

/** Lanes that need a look open by themselves; a quiet one stays folded. */
export const opensByItself = (status: WorkerStatus): boolean => status.light === 'amber' || status.light === 'red';

/** The runs of one working column, oldest first (a stable lane order). */
export function lanesOfColumn(runs: readonly RunInfo[], phaseId: string): RunInfo[] {
  return runs
    .filter((r) => (r.column ?? null) === phaseId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}
