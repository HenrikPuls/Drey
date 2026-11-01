/**
 * The fleet ledger (ADR-0088, E1 — data form; its writers and readers
 * arrive with the watcher/chat in E3/E5). `_meta/ledger.jsonl` in the
 * tickets repo: append-only JSON Lines, one object per fleet event —
 *
 *   {"ts":"2026-11-01T14:30:00Z","ticket":"T-0086","persona":"ben","model":"glm-5.2","event":"dispatched"}
 *   {"ts":"2026-11-01T15:12:00Z","ticket":"T-0086","persona":"ben","model":"glm-5.2","event":"phase","detail":"build -> review","cost":0.61}
 *
 * The git log stays the history of the tickets' CONTENTS; the ledger is
 * the realtime hook for Mission Control and the "what did the week cost"
 * intent — no Markdown parsing to answer it.
 */

export type LedgerEvent = 'dispatched' | 'phase' | 'proof_ready' | 'merged' | 'archived';

export const LEDGER_EVENTS: readonly LedgerEvent[] = ['dispatched', 'phase', 'proof_ready', 'merged', 'archived'];

export interface LedgerEntry {
  /** ISO-8601 UTC stamp. */
  readonly ts: string;
  /** Ticket id (`T-0001`). */
  readonly ticket: string;
  /** The persona that ran (the worker id until personas land in E3). */
  readonly persona: string;
  /** The model that ACTUALLY ran — router or not, the ledger audits it. */
  readonly model: string;
  readonly event: LedgerEvent;
  /** Optional cost figure in credits (the telemetry's token-cost fold). */
  readonly cost?: number;
  /** Optional short note (e.g. `build -> review` for a phase event). */
  readonly detail?: string;
}

export function isLedgerEvent(word: string): word is LedgerEvent {
  return (LEDGER_EVENTS as readonly string[]).includes(word);
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['ts'] === 'string' &&
    typeof v['ticket'] === 'string' &&
    typeof v['persona'] === 'string' &&
    typeof v['model'] === 'string' &&
    typeof v['event'] === 'string' &&
    isLedgerEvent(v['event']) &&
    (v['cost'] === undefined || (typeof v['cost'] === 'number' && Number.isFinite(v['cost']) && v['cost'] >= 0)) &&
    (v['detail'] === undefined || typeof v['detail'] === 'string')
  );
}

/** Parse the whole ledger, oldest first; malformed lines are skipped —
 *  the file is a machine interface that must never take a reader down. */
export function parseLedger(text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (isLedgerEntry(value)) {
        entries.push(value);
      }
    } catch {
      // a torn or human-edited line — skipped, never fatal
    }
  }
  return entries;
}

/**
 * Append one event as a single JSON line. Throws on an invalid entry so
 * a buggy writer fails at the source instead of poisoning the file.
 */
export function appendLedgerEvent(text: string, entry: LedgerEntry): string {
  if (!isLedgerEntry(entry)) {
    throw new Error(`invalid ledger entry: ${JSON.stringify(entry)}`);
  }
  // Stable key order keeps the append byte-stable through reads/writes.
  const line = JSON.stringify({
    ts: entry.ts,
    ticket: entry.ticket,
    persona: entry.persona,
    model: entry.model,
    event: entry.event,
    ...(entry.cost !== undefined ? { cost: entry.cost } : {}),
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
  });
  return text === '' ? line : `${text.replace(/\s+$/, '')}\n${line}`;
}
