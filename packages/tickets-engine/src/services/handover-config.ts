import { parseWorkerValue } from '../fleet/assignment';
import { normalizeFleetHandover, WORKER_PROVIDERS, type FleetHandoverConfig } from '../fleet/protocol';
import type { BoardSnapshot } from '../contracts/tickets';

/**
 * The handover thresholds from the plugin config (T-0049): the two base
 * keys plus every per-provider/model override flat key named — the store's
 * keys are opaque strings, so the caller hands over the key set worth
 * reading (the board's worker/model pins); no UI writes the overrides.
 */
export async function handoverFromConfig(
  get: <T>(key: string) => Promise<T | undefined>,
  overrideKeys: readonly string[] = [],
): Promise<FleetHandoverConfig> {
  const raw: Record<string, unknown> = {};
  const base = await get<number>('fleet.compactAboveTokens');
  if (base !== undefined) {
    raw.compactAboveTokens = base;
  }
  const ttl = await get<number>('fleet.resumePauseTtlMin');
  if (ttl !== undefined) {
    raw.resumePauseTtlMin = ttl;
  }
  const cap = await get<number>('fleet.contextCapTokens');
  if (cap !== undefined) {
    raw.contextCapTokens = cap;
  }
  const overrides: Record<string, number> = {};
  const capOverrides: Record<string, number> = {};
  for (const key of [...WORKER_PROVIDERS, ...overrideKeys]) {
    const value = await get<number>(`fleet.compactAboveTokens.${key}`);
    if (value !== undefined) {
      overrides[key] = value;
    }
    const capValue = await get<number>(`fleet.contextCapTokens.${key}`);
    if (capValue !== undefined) {
      capOverrides[key] = capValue;
    }
  }
  if (Object.keys(overrides).length > 0) {
    raw.compactAboveTokensOverrides = overrides;
  }
  if (Object.keys(capOverrides).length > 0) {
    raw.contextCapTokensOverrides = capOverrides;
  }
  return normalizeFleetHandover(raw);
}


/**
 * The override keys worth reading for one board (T-0049): both worker
 * providers always, plus every worker/model pin a run of this board can
 * resolve to — pipeline columns, tickets, repos and the configured
 * default. A column's bare `model:` pairs with its pin's provider (the
 * fleet floor when the column names none).
 */
export function handoverOverrideKeys(snap: BoardSnapshot, defaultWorker: string): readonly string[] {
  const keys = new Set<string>(WORKER_PROVIDERS);
  const add = (value: string | null): void => {
    const text = value?.trim() ?? '';
    if (text !== '') {
      keys.add(text);
    }
  };
  const floorProvider = parseWorkerValue(defaultWorker)?.provider ?? 'opencode';
  add(defaultWorker);
  for (const phase of snap.pipeline) {
    add(phase.worker);
    if (phase.model !== null && phase.model.trim() !== '') {
      const provider = phase.worker !== null ? parseWorkerValue(phase.worker)?.provider : undefined;
      keys.add(`${provider ?? floorProvider}/${phase.model.trim()}`);
    }
  }
  for (const column of snap.columns) {
    for (const card of column.tickets) {
      add(card.meta.worker);
    }
  }
  for (const repo of snap.repos) {
    add(repo.worker);
  }
  return [...keys];
}

/**
 * The remote gateway's owner (req-66); stopped on deactivate.
 */
