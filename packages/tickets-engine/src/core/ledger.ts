/**
 * The fleet ledger (E7, concept §3.3): `_meta/ledger.jsonl`, one JSON
 * line per fleet event — the real-time hook for Mission Control and
 * the reports, without parsing Markdown. Append-only; the git log
 * stays the history of contents, the ledger is the events' fast lane.
 *
 *     {"v":1,"ts":"2026-11-02T09:00:00Z","event":"dispatched","ticket":"T-0002","persona":"pia","model":"opus"}
 *     {"v":1,"ts":"2026-11-02T09:40:00Z","event":"phase","ticket":"T-0002","from":"build","to":"review"}
 *     {"v":1,"ts":"2026-11-02T09:45:00Z","event":"proof_ready","ticket":"T-0001"}
 *     {"v":1,"ts":"2026-11-02T10:00:00Z","event":"merged","ticket":"T-0001","persona":"tessa"}
 *     {"v":1,"ts":"2026-11-02T10:05:00Z","event":"archived","ticket":"T-0001"}
 *
 * Cost rides the events that know it (`cost` in USD cents? No — the
 * house telemetry reports tokens; `cost` is the fractional dollar the
 * report computes, rounded to four digits).
 */

export type LedgerEventKind = 'dispatched' | 'phase' | 'proof_ready' | 'merged' | 'archived';

export interface LedgerEvent {
  readonly kind: LedgerEventKind;
  readonly ts: string;
  readonly ticket: string;
  readonly persona: string | null;
  readonly model: string | null;
  /** Settled-run cost in dollars when known; null otherwise. */
  readonly cost: number | null;
  readonly from: string | null;
  readonly to: string | null;
}

export interface LedgerWrite {
  readonly kind: LedgerEventKind;
  readonly ticket: string;
  readonly persona?: string | null;
  readonly model?: string | null;
  readonly cost?: number | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

export const LEDGER_FILE = 'tickets/_meta/ledger.jsonl';

/** The strict one-line wire shape; null refuses instead of guessing. */
export function parseLedgerLine(raw: string): LedgerEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj['v'] !== 1) {
    return null;
  }
  const kind = obj['event'];
  const ts = typeof obj['ts'] === 'string' ? obj['ts'] : '';
  const ticket = typeof obj['ticket'] === 'string' ? obj['ticket'] : '';
  if (!isKind(kind) || ts === '' || ticket === '') {
    return null;
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const cost = typeof obj['cost'] === 'number' && Number.isFinite(obj['cost']) ? Math.round(obj['cost'] * 10_000) / 10_000 : null;
  return {
    kind,
    ts,
    ticket,
    persona: str(obj['persona']),
    model: str(obj['model']),
    cost,
    from: str(obj['from']),
    to: str(obj['to']),
  };
}

/** Reads the whole ledger tolerantly; torn lines are skipped. */
export function parseLedger(text: string): readonly LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const event = parseLedgerLine(line);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

/** The one-line serialization an append-only writer emits. */
export function renderLedgerLine(ts: string, write: LedgerWrite): string {
  return `${JSON.stringify({
    v: 1,
    ts,
    event: write.kind,
    ticket: write.ticket,
    ...(write.persona != null && write.persona !== '' ? { persona: write.persona } : {}),
    ...(write.model != null && write.model !== '' ? { model: write.model } : {}),
    ...(write.cost != null ? { cost: write.cost } : {}),
    ...(write.from != null && write.from !== '' ? { from: write.from } : {}),
    ...(write.to != null && write.to !== '' ? { to: write.to } : {}),
  })}\n`;
}

function isKind(value: unknown): value is LedgerEventKind {
  return value === 'dispatched' || value === 'phase' || value === 'proof_ready' || value === 'merged' || value === 'archived';
}
