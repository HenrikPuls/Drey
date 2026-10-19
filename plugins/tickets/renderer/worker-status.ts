/**
 * The pure half of the board's worker lanes: how a live run's numbers
 * become a traffic light, a context fill and the short texts the lane
 * shows. No DOM — the board draws it (index.ts), the spec pins it.
 */
import type { RunInfo } from '../main/fleet/protocol';

/** The model window the context bar is measured against (the runner does not know it). */
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

/** The share of the window in use, 0..1; null while no context size is known. */
export function contextFill(run: RunInfo, windowTokens: number = DEFAULT_CONTEXT_WINDOW): number | null {
  const used = run.contextTokens;
  if (used === undefined || used === null || windowTokens <= 0) {
    return null;
  }
  return Math.min(1, used / windowTokens);
}

/** Traffic light of one live run: stalled beats a full context beats fine. */
export function workerStatus(run: RunInfo, nowMs: number, windowTokens: number = DEFAULT_CONTEXT_WINDOW): WorkerStatus {
  if (run.state === 'detached') {
    return { light: 'amber', label: 'Detached' };
  }
  // A worker that waits on the owner (req-57) needs a look — never a stall.
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
  const fill = contextFill(run, windowTokens);
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

/** Lanes that need a look open by themselves; a quiet one stays folded. */
export const opensByItself = (status: WorkerStatus): boolean => status.light === 'amber' || status.light === 'red';

/** The runs of one working column, oldest first (a stable lane order). */
export function lanesOfColumn(runs: readonly RunInfo[], phaseId: string): RunInfo[] {
  return runs
    .filter((r) => (r.column ?? null) === phaseId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}
