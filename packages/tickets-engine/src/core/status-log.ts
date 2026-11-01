/**
 * The per-ticket status log (ADR-0088, E1 — data form; consumers arrive
 * with the watcher and the chat in E3/E5). A `<ticket>.status.log` sits
 * beside the ticket file: append-only, machine-written, one verb line per
 * event. Personas write exactly one line per event —
 *
 *   - 2026-11-01T14:30:00Z working: plan draft ready
 *   - 2026-11-01T14:31:12Z needs-decision: [key=base-ref] fork from the freshest ref?
 *   - 2026-11-01T15:02:40Z paused: waiting for CI until 15:00
 *   - 2026-11-01T16:00:00Z resolved: base-ref
 *
 * The log is the single source for "needs you" and the state chips
 * (Firstmate's keyed decisions): an open `needs-decision`/`blocked` KEY
 * stays visible until it is explicitly closed by `resolved: <key>` — no
 * matter how many newer lines pile up on top (the open-decisions fold).
 * Derived state is computed, never stored.
 */

export type StatusVerb = 'working' | 'blocked' | 'needs-decision' | 'paused' | 'done' | 'failed' | 'resolved';

export const STATUS_VERBS: readonly StatusVerb[] = ['working', 'blocked', 'needs-decision', 'paused', 'done', 'failed', 'resolved'];

/** The verbs whose detail may carry a `[key=<slug>]` — the foldable decisions. */
export const KEYED_VERBS: readonly StatusVerb[] = ['needs-decision', 'blocked'];

export interface StatusEntry {
  /** ISO-8601 UTC stamp, as written. */
  readonly ts: string;
  readonly verb: StatusVerb;
  /**
   * The fold key for the keyed verbs (`[key=base-ref]` in the detail);
   * null for the other verbs and for malformed key shapes.
   */
  readonly key: string | null;
  /** The detail after the verb, key marker stripped. */
  readonly detail: string;
}

export interface OpenDecision {
  readonly key: string;
  /** The verb that opened it (`needs-decision` or `blocked`). */
  readonly verb: StatusVerb;
  readonly ts: string;
  readonly detail: string;
}

const LINE_RE = /^- (\S+) (working|blocked|needs-decision|paused|done|failed|resolved):(?:\s+(.*))?$/;
const KEY_RE = /^\[key=([a-z0-9][a-z0-9-]*)\]\s*(.*)$/;

export function isStatusVerb(word: string): word is StatusVerb {
  return (STATUS_VERBS as readonly string[]).includes(word);
}

/** Parse the whole log, oldest first. Lines the grammar does not know —
 *  human scribbles, empty lines — are skipped, never fatal: the file is a
 *  machine interface a human may still touch. */
export function parseStatusLog(text: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '' || !line.startsWith('- ')) {
      continue;
    }
    const match = LINE_RE.exec(line);
    if (match === null) {
      continue;
    }
    const verb = match[2] as StatusVerb;
    let detail = (match[3] ?? '').trim();
    let key: string | null = null;
    if (KEYED_VERBS.includes(verb)) {
      const keyed = KEY_RE.exec(detail);
      if (keyed !== null) {
        key = keyed[1]!;
        detail = keyed[2]!.trim();
      }
    } else if (verb === 'resolved') {
      // `resolved: <key>` carries the key positionally — the first token
      // of the detail (a note may follow).
      const positional = /^([a-z0-9][a-z0-9-]*)(?:\s+(.*))?$/.exec(detail);
      if (positional !== null) {
        key = positional[1]!;
        detail = (positional[2] ?? '').trim();
      }
    }
    entries.push({ ts: match[1]!, verb, key, detail });
  }
  return entries;
}

function isoUtc(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Append one machine-shaped line. The key convention is enforced for the
 * keyed verbs: pass `key` and it is written as `[key=<slug>]`; a key that
 * does not match the slug grammar is refused (a mistyped key would open a
 * decision nothing can close).
 */
export function appendStatusLine(text: string, now: Date, verb: StatusVerb, detail: string, key?: string): string {
  const stamp = isoUtc(now);
  const clean = detail.trim();
  if (key !== undefined && KEYED_VERBS.includes(verb)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
      throw new Error(`status-log key must be [a-z0-9-], got "${key}"`);
    }
    const line = `- ${stamp} ${verb}: [key=${key}] ${clean}`;
    return text === '' ? line : `${text.replace(/\s+$/, '')}\n${line}`;
  }
  const line = `- ${stamp} ${verb}: ${clean}`;
  return text === '' ? line : `${text.replace(/\s+$/, '')}\n${line}`;
}

/**
 * The open-decisions fold: the keys whose LAST event is `needs-decision`
 * or `blocked` — a `resolved: <key>` (or a newer keyed line of the same
 * key) closes it, anything else leaves it open. Verbs without a key never
 * open one. Deterministic and order-only: no clocks, no heuristics.
 */
export function openDecisions(entries: readonly StatusEntry[]): OpenDecision[] {
  const state = new Map<string, { verb: StatusVerb; ts: string; detail: string }>();
  for (const entry of entries) {
    if (entry.key === null) {
      continue;
    }
    if (entry.verb === 'resolved') {
      state.delete(entry.key);
    } else if (KEYED_VERBS.includes(entry.verb)) {
      state.set(entry.key, { verb: entry.verb, ts: entry.ts, detail: entry.detail });
    }
  }
  return [...state.entries()].map(([key, open]) => ({ key, ...open }));
}
