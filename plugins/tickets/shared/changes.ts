/**
 * The `## Changes` section (req-75 W3, ADR-0087 decision 3): what the
 * build worker writes into the ticket so its page can say in plain
 * words what changed for the owner, where, which checks passed and how
 * to try it — plus the ticket's story ("How it got here"), read from
 * the Log section alone. Pure and tolerant: labels case-insensitive,
 * `-`/`*` bullets, missing parts null/empty, never a throw. The section
 * is the contract — no diff parsing on the desk (ADR-0087).
 */

// --- the `## Changes` section -------------------------------------------------

export interface ChangedFile {
  /** The git status letter as written. */
  readonly status: 'A' | 'M' | 'D' | 'R';
  readonly path: string;
  readonly why: string;
}

export interface ParsedChanges {
  /** `**What changed for you:**` — the whole text, paragraphs joined by `\n`. */
  readonly forYou: string | null;
  readonly files: readonly ChangedFile[];
  readonly checks: readonly string[];
  /** `**How to try it:**` — the steps as one line. */
  readonly howToTry: string | null;
}

/** `**What changed for you:**` and friends — bold optional, case-free, colon
 *  before or after the bold close; anything else is not a label. */
const LABEL =
  /^\s*\**\s*(what changed for you|where|checks|how to try it)\s*(?::|\*\*|$)\s*\**\s*:?\s*(.*)$/i;

/** One `Where` bullet: status letter, backticked path (ticks optional), the
 *  why after an em/en dash or a hyphen. */
const FILE_ROW = /^[-*]\s+([AMDR])\s+`?([^`—–]+?)`?\s*(?:[—–-]\s+(.*))?$/i;

/** Any other bullet (`- text` / `* text`). */
const BULLET = /^[-*]\s+(.+)$/;

type ChangeLabel = 'forYou' | 'where' | 'checks' | 'howToTry';

const LABEL_OF: Readonly<Record<string, ChangeLabel>> = {
  'what changed for you': 'forYou',
  where: 'where',
  checks: 'checks',
  'how to try it': 'howToTry',
};

/** The section body: the lines under `## Changes` up to the next H2. */
function changesBody(ticketText: string): string[] | null {
  const lines = ticketText.split('\n');
  const at = lines.findIndex((line) => /^##\s+Changes\s*$/.test(line));
  if (at < 0) {
    return null;
  }
  const body: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      break;
    }
    body.push(lines[i]!);
  }
  return body;
}

/** The `## Changes` section of a ticket body; null when absent. */
export function parseChanges(ticketText: string): ParsedChanges | null {
  const body = changesBody(ticketText);
  if (body === null) {
    return null;
  }
  let forYou: string | null = null;
  let howToTry: string | null = null;
  const files: ChangedFile[] = [];
  const checks: string[] = [];
  let label: ChangeLabel | null = null;
  const forYouLines: string[] = [];
  const howToTryLines: string[] = [];
  for (const line of body) {
    const match = LABEL.exec(line);
    if (match !== null) {
      // Close the previous paragraph label before the next one reads.
      if (label === 'forYou') {
        forYou = forYouLines.join('\n');
      } else if (label === 'howToTry') {
        howToTry = howToTryLines.join('\n');
      }
      const rest = match[2]!.trim();
      label = LABEL_OF[match[1]!.toLowerCase()]!;
      if (label === 'forYou') {
        forYouLines.length = 0;
        if (rest !== '') {
          forYouLines.push(rest);
        }
      } else if (label === 'howToTry') {
        howToTryLines.length = 0;
        if (rest !== '') {
          howToTryLines.push(rest);
        }
      }
      continue;
    }
    if (label === 'where') {
      const row = FILE_ROW.exec(line);
      if (row !== null) {
        files.push({
          status: row[1]!.toUpperCase() as ChangedFile['status'],
          path: row[2]!.trim(),
          why: (row[3] ?? '').trim(),
        });
      }
      continue;
    }
    if (label === 'checks') {
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        checks.push(bullet[1]!.trim());
      }
      continue;
    }
    if (label === 'forYou') {
      if (line.trim() !== '') {
        forYouLines.push(line.trim());
      }
      continue;
    }
    if (label === 'howToTry') {
      if (line.trim() !== '') {
        howToTryLines.push(line.trim());
      }
    }
  }
  if (label === 'forYou') {
    forYou = forYouLines.join('\n');
  } else if (label === 'howToTry') {
    howToTry = howToTryLines.join('\n');
  }
  return { forYou, files, checks, howToTry };
}

// --- the story ----------------------------------------------------------------

export interface StoryItem {
  /** The stamp's clock, `HH:MM` (UTC, as written in the Log). */
  readonly at: string;
  readonly what: string;
  readonly who: string;
}

export interface StoryTotals {
  /** First to last Log stamp, in whole minutes; null with no readable stamp. */
  readonly minutes: number | null;
  /** Tokens summed from the run-usage Log lines; null when none reports. */
  readonly tokens: number | null;
}

/** The machine Log line: `- '<UTC stamp>' <who> — <what>`; humans write free. */
const LOG_LINE = /^-\s+'([^']+)'\s+(\S+)\s+—\s+(.*)$/;

const STAMP_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** `run R-x done — gate green, moving to <phase>` (the fleet's own move). */
const RUN_MOVED = /^run \S+ done — gate green, moving to (\S+)$/;

/** `run R-x started (opencode[, provider/model]) — …` names the worker. */
const RUN_STARTED = /^run \S+ started \(([^,)]+)(?:,\s*([^)]+))?\)/;

/** `run done — 96k in (12k cached) / 4k out` — the usage tail (any end state). */
const USAGE = /(\d+(?:\.\d+)?)([kKmM])?\s+in\b[^/]*\/\s*(\d+(?:\.\d+)?)([kKmM])?\s+out\b/;

/** The plain transition `<from> -> <to>`. */
const MOVED = /^(\S+)\s+->\s+(\S+)$/;

/** The transition targets the story names; anything else shows as written. */
const MOVE_LABEL: Readonly<Record<string, string>> = {
  plan: 'Planning',
  'plan-review': 'Planned',
  build: 'Building',
  commit: 'Merging',
  done: 'Ready to try',
};

function tokenCount(raw: string, suffix: string | undefined): number {
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) {
    return 0;
  }
  const k = suffix === 'k' || suffix === 'K' ? 1_000 : suffix === 'm' || suffix === 'M' ? 1_000_000 : 1;
  return n * k;
}

/** The `who` of one line: `you` for the owner, else the worker the run named
 *  (sticky from its start line), else the actor as written. */
function whoOf(actor: string, worker: string | null): string {
  if (actor.startsWith('owner@')) {
    return 'you';
  }
  return worker ?? actor;
}

/** The short model id (`provider/model` → `model`). */
function modelShort(model: string): string {
  const parts = model.trim().split('/');
  return parts[parts.length - 1]!.trim();
}

/** What the Ready page's `changes` IPC returns: the section and the story. */
export interface ChangesReply {
  /** The parsed `## Changes` section; null when the ticket has none. */
  readonly changes: ParsedChanges | null;
  readonly story: readonly StoryItem[];
  readonly totals: StoryTotals;
}

export function storyOf(ticketText: string): { readonly items: readonly StoryItem[]; readonly totals: StoryTotals } {  const items: StoryItem[] = [];
  let first: number | null = null;
  let last: number | null = null;
  let tokens: number | null = null;
  // Where the ticket sits as the lines walk forward, and which worker the
  // current run named — both derived from the text alone.
  let phase: string | null = null;
  let worker: string | null = null;
  for (const line of ticketText.split('\n')) {
    const match = LOG_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const stamp = match[1]!;
    const actor = match[2]!;
    const what = match[3]!;
    const at = STAMP_CLOCK.test(stamp) ? stamp.slice(11, 16) : '';
    const t = Date.parse(stamp);
    if (!Number.isNaN(t)) {
      first ??= t;
      last = t;
    }

    const started = RUN_STARTED.exec(what);
    if (started !== null) {
      worker =
        started[2] !== undefined ? `${started[1]!.trim()} · ${modelShort(started[2])}` : started[1]!.trim();
      continue; // a start is no story beat of its own
    }

    const usage = USAGE.exec(what);
    if (usage !== null) {
      tokens = (tokens ?? 0) + tokenCount(usage[1]!, usage[2]) + tokenCount(usage[3]!, usage[4]);
    }

    const created = /^created in (\S+)$/.exec(what);
    if (created !== null) {
      phase = created[1]!;
      items.push({ at, what: 'Captured', who: whoOf(actor, worker) });
      continue;
    }
    if (what.startsWith('sent back:')) {
      items.push({ at, what: 'Sent back', who: whoOf(actor, worker) });
      continue;
    }
    if (what === 'archived') {
      items.push({ at, what: 'Accepted', who: whoOf(actor, worker) });
      continue;
    }
    const runMoved = RUN_MOVED.exec(what);
    if (runMoved !== null) {
      const to = runMoved[1]!;
      // A run that finishes in build is the built-and-tested beat; any other
      // column shows the move as written.
      items.push({ at, what: phase === 'build' ? 'Built and tested' : `-> ${to}`, who: whoOf(actor, worker) });
      phase = to;
      continue;
    }
    const moved = MOVED.exec(what);
    if (moved !== null) {
      const to = moved[2]!;
      items.push({ at, what: MOVE_LABEL[to] ?? `-> ${to}`, who: whoOf(actor, worker) });
      phase = to;
    }
  }
  return {
    items,
    totals: {
      minutes: first === null || last === null ? null : Math.round((last - first) / 60_000),
      tokens,
    },
  };
}

