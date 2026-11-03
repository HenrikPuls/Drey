/**
 * The run estimate (E11-4, concept v2, owner decision D9): what a gate
 * run is likely to cost, taken only from the owner's own history — the
 * `## Verlauf` lines of every ticket, archive included. An estimate
 * exists for a (gate, persona, model) triple once at least
 * {@link MIN_ESTIMATE_RUNS} earlier runs of exactly that triple handed
 * their step over; with fewer there is no number, never a guess. Only
 * handed-over runs count (a failed or stopped run is a partial cost).
 */
import type { VerlaufEntry } from './verlauf';

export const MIN_ESTIMATE_RUNS = 3;

export interface EstimateKey {
  readonly gate: string;
  readonly persona: string;
  readonly model: string;
}

export interface RunEstimate extends EstimateKey {
  /** How many earlier runs the figures rest on (the basis the UI states). */
  readonly runs: number;
  /** Median cost in dollars. */
  readonly cost: number;
  /** Median wall-clock minutes; null when no matching run recorded one. */
  readonly minutes: number | null;
  /** Median tokens; null when no matching run recorded them. */
  readonly tokens: number | null;
}

/** `48k` → 48000, `3.4M` → 3400000, `800` → 800; null for anything else. */
export function tokenCountOf(words: string): number | null {
  const match = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(words.trim());
  if (match === null) {
    return null;
  }
  const scale = match[2] === 'M' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  return Math.round(Number(match[1]) * scale);
}

/** `12m` → 12; null for anything else. */
export function minutesOf(words: string): number | null {
  const match = /^(\d+)m$/.exec(words.trim());
  return match === null ? null : Number(match[1]);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const same = (a: string | null, b: string): boolean => a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The estimate for one triple over the history; null below the minimum. */
export function estimateFrom(history: readonly VerlaufEntry[], key: EstimateKey): RunEstimate | null {
  const runs = history.filter(
    (e) =>
      e.ausgang === 'handed-over' &&
      e.cost !== null &&
      same(e.phase, key.gate) &&
      same(e.persona, key.persona) &&
      same(e.model, key.model),
  );
  if (runs.length < MIN_ESTIMATE_RUNS) {
    return null;
  }
  const cost = median(runs.map((e) => e.cost!));
  if (cost === null) {
    return null;
  }
  const rounded = (v: number | null): number | null => (v === null ? null : Math.round(v));
  return {
    ...key,
    runs: runs.length,
    cost: Math.round(cost * 10_000) / 10_000,
    minutes: rounded(median(runs.flatMap((e) => minutesOf(e.dauer) ?? []))),
    tokens: rounded(median(runs.flatMap((e) => tokenCountOf(e.tokens) ?? []))),
  };
}
