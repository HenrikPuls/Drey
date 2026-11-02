/**
 * The ticket status log (E7, concept §3.3): `<ticket>.status.log` beside
 * the ticket file lives one machine line per event — the persona's
 * verbs. It is the single source for "whose turn / what blocks": the
 * UI reads projections from it, never free text. Strict writer,
 * tolerant reader (ADR-0076 discipline).
 *
 *     - '2026-11-02T09:00:00Z' working: build on opus
 *     - '2026-11-02T09:12:00Z' needs-decision: [palette-shortcut] Which shortcut should open the palette?
 *     - '2026-11-02T09:30:00Z' blocked: waiting for CI
 *     - '2026-11-02T09:31:00Z' paused: owner review until 15:00
 *     - '2026-11-02T09:40:00Z' resolved: palette-shortcut
 *     - '2026-11-02T09:45:00Z' done: handed over
 *     - '2026-11-02T09:46:00Z' failed: gate red — npm test
 *
 * Open `needs-decision`/`blocked` keys stay visible until a `resolved:`
 * line closes them — no matter how many newer lines pile on top
 * (the open-decisions fold).
 */

export type StatusVerb = 'working' | 'needs-decision' | 'blocked' | 'paused' | 'done' | 'failed' | 'resolved';

export interface StatusLine {
  /** ISO stamp as written. */
  readonly at: string;
  readonly verb: StatusVerb;
  /**
   * The decision key (`[palette-shortcut]`); null for the other verbs —
   * and for needs-decision lines written without a key.
   */
  readonly key: string | null;
  /** The free-text payload; '' when the line carries none. */
  readonly text: string;
}

const LINE = /^- '([^']+)' (working|needs-decision|blocked|paused|done|failed|resolved): ?(.*)$/;

/** Reads the log tolerantly; broken lines are skipped, never guessed. */
export function parseStatusLog(text: string): readonly StatusLine[] {
  const lines: StatusLine[] = [];
  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw.trim());
    if (match === null) {
      continue;
    }
    let payload = match[3]!.trim();
    let key: string | null = null;
    if (match[2] === 'resolved') {
      // `resolved: <key>` — the payload IS the key.
      if (/^[a-z0-9][a-z0-9-]{0,63}$/i.test(payload)) {
        key = payload.toLowerCase();
        payload = '';
      }
    } else if (match[2] === 'needs-decision' || match[2] === 'blocked') {
      const keyed = /^\[([a-z0-9][a-z0-9-]{0,63})\]\s*(.*)$/i.exec(payload);
      if (keyed !== null) {
        key = keyed[1]!.toLowerCase();
        payload = keyed[2]!.trim();
      }
    }
    lines.push({ at: match[1]!, verb: match[2] as StatusVerb, key, text: payload });
  }
  return lines;
}

/** One open decision/blocker: the projection the Needs-you list renders. */
export interface OpenStatusItem {
  readonly verb: 'needs-decision' | 'blocked';
  readonly key: string | null;
  readonly text: string;
  readonly since: string;
}

/**
 * The open-decisions fold: every needs-decision/blocked key that has
 * not seen a matching `resolved:` line, oldest first. A keyless line is
 * its own item and can only be closed by a keyless `resolved:` … which
 * never matches — so writers SHOULD key their decisions; the reader
 * surfaces keyless ones instead of dropping them (visible, not silent).
 */
export function openStatusItems(lines: readonly StatusLine[]): readonly OpenStatusItem[] {
  const open = new Map<string, OpenStatusItem>();
  const keyless: OpenStatusItem[] = [];
  for (const line of lines) {
    if (line.verb === 'resolved') {
      if (line.key !== null) {
        open.delete(line.key);
      }
      continue;
    }
    if (line.verb !== 'needs-decision' && line.verb !== 'blocked') {
      continue;
    }
    const item: OpenStatusItem = { verb: line.verb, key: line.key, text: line.text, since: line.at };
    if (line.key === null) {
      keyless.push(item);
    } else {
      open.set(line.key, item);
    }
  }
  return [...keyless, ...open.values()];
}

/** Appends one strict line; the file may be absent (the first line starts it). */
export function appendStatusLine(text: string, at: string, verb: StatusVerb, payload: string): string {
  const base = text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
  return `${base}- '${at}' ${verb}: ${payload.trim()}\n`;
}
