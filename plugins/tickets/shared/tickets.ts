/**
 * The tickets plugin's cross-layer contract (ADR-0076): the IPC payload
 * shapes the board panel and the main-side board service exchange, plus
 * the tiny pure helpers both sides need. The full format specification
 * is `specs/ticket-schema.md`; this file mirrors only what crosses the
 * bridge.
 *
 * Everything the renderer knows about the board comes from a
 * BoardSnapshot — the renderer never parses ticket files (the YAML
 * engine and the validator are main-side, where the `yaml` package is
 * reachable; the plugin renderer bundle may not import packages).
 */

/** `T-` + at least four digits (`T-0042`). Grammar of ids AND file stems. */
export const TICKET_ID_PATTERN = /^T-\d{4,}$/;

// --- numbered phase folders (T-0041, ADR-0076 later change) -----------------
//
// Phase directories are named `NN-<id>` with `NN` = the phase's 1-based
// pipeline position × 10. Everything inside a ticket file — `entered-*`
// keys, order.md sections, branch names — keeps the clean id; only the
// directory carries the number. Readers strip the prefix and match the
// rest against pipeline.md ids; an unprefixed directory stays tolerated.

/** The reserved archive folder beside `_meta` — never a column, never numbered. */
export const TICKETS_ARCHIVE_DIR = 'tickets/archive';

/** Strips a leading `\d+-` from a directory name; unprefixed stays as is. */
export function stripPhasePrefix(dir: string): string {
  return dir.replace(/^\d+-/, '');
}

/** `(1-based pipeline position) * 10` + '-' + id → '10-inbox' … '80-done'. */
export function phaseDirectoryName(position1: number, id: string): string {
  return `${String(position1 * 10).padStart(2, '0')}-${id}`;
}

// ---------------------------------------------------------------------------
// The pipeline's handover spec (`_meta/pipeline.md`, ADR-0076):
// `manual | agent <prompt-ref>[@<worker>] | ci | none`. Parsed here so
// the board, the fleet run start and the specs share one grammar.

export type HandoverMode = 'manual' | 'agent' | 'ci' | 'none';

export interface HandoverSpec {
  readonly mode: HandoverMode;
  /** The prompt the fleet runs (`agent build-default`); null unless agent. */
  readonly promptRef: string | null;
  /** The worker pin (`@opencode`) on the handover, when present. */
  readonly worker: string | null;
}

/** Reads a handover spec; anything unreadable degrades to `manual` (the
 *  asymmetric-tolerance rule: forgive, never guess). */
export function parseHandover(spec: string): HandoverSpec {
  const text = spec.trim();
  if (text === 'manual' || text === 'ci' || text === 'none') {
    return { mode: text, promptRef: null, worker: null };
  }
  if (text === '' || text === 'agent') {
    return { mode: 'agent', promptRef: null, worker: null };
  }
  const match = /^agent\s+(\S+?)(?:@(\S+))?$/.exec(text);
  if (match !== null) {
    return { mode: 'agent', promptRef: match[1]!, worker: match[2] ?? null };
  }
  return { mode: 'manual', promptRef: null, worker: null };
}

/** The deterministic work-branch rule — `t/` + the id, both directions. */
export function branchForTicket(id: string): string {
  return `t/${id}`;
}

export function ticketOfBranch(branch: string): string | null {
  const match = /^t\/(T-\d{4,})$/.exec(branch);
  return match === null ? null : match[1]!;
}

export type TicketPriority = 'urgent' | 'high' | 'normal' | 'low';

export const TICKET_PRIORITIES: readonly TicketPriority[] = [
  'urgent',
  'high',
  'normal',
  'low',
];

/** Sort weight inside derived column order — smaller sorts first. */
export function priorityWeight(priority: TicketPriority): number {
  switch (priority) {
    case 'urgent':
      return 0;
    case 'high':
      return 1;
    case 'normal':
      return 2;
    case 'low':
      return 3;
  }
}

/** Default `rank` when a file omits it (the reader's normalization). */
export const DEFAULT_RANK = 5000;

/**
 * A UTC stamp in the schema's exact shape — `YYYY-MM-DDTHH:mm:ssZ`,
 * the string callers put into YAML double-quoted.
 */
export function formatUtcStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}Z`
  );
}

/** One validator finding. Levels: `error` blocks agent actions (M84+),
 * `warning` marks rule violations that still render (branch mismatch),
 * `noise` is tolerated deviation (unknown keys, stray files). Never a
 * guess — always visible (ADR-0076: tolerate noise, never ambiguity). */
export interface TicketIssue {
  readonly level: 'error' | 'warning' | 'noise';
  readonly message: string;
}

/** The live-run map (ADR-0075 run control; written from M84, validated now). */
export interface TicketRun {
  readonly pid: number;
  readonly 'started-at': string;
  readonly stream: string;
}

/** Parsed, normalized ticket frontmatter (all optionals reflect absence). */
export interface TicketMeta {
  readonly id: string | null;
  readonly title: string | null;
  readonly repo: string | null;
  /** The ticket's worker pin (`worker: opencode`); null = not pinned. */
  readonly worker: string | null;
  readonly priority: TicketPriority;
  readonly rank: number;
  readonly branch: string | null;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly run: TicketRun | null;
  readonly references: readonly string[];
  readonly parkedReason: string | null;
  readonly parkedAt: string | null;
  /** phase id -> most recent `entered-<phase>` stamp as written. */
  readonly entered: Readonly<Record<string, string>>;
}

/** One ticket as the board renders it — meta plus derived/board context. */
export interface TicketCard {
  readonly id: string;
  /** Current vault-relative path (`tickets/<phase>/<id>.md`). */
  readonly path: string;
  /** The directory the file sits in (its current phase, or an unknown one). */
  readonly phase: string;
  readonly meta: TicketMeta;
  readonly pinned: boolean;
  /** The resolved fleet worker for this card (M84 display resolution). */
  readonly worker: string;
  readonly issues: readonly TicketIssue[];
}

/** One pipeline phase from `tickets/_meta/pipeline.md`. */
export interface PipelinePhase {
  readonly id: string;
  readonly title: string;
  readonly wip: number | null;
  readonly claim: boolean;
  /** Raw handover spec (`manual | agent <ref>[@<worker>] | ci | none`). */
  readonly handover: string;
}

/**
 * The display-grade worker resolution for a card (M84): the ticket's
 * pin wins, then the phase handover's pin, then the repo default, then
 * the plugin's configured default. The run start re-resolves strictly
 * (unreadable pins refuse there) — this one only picks what a card
 * shows.
 */
export function resolveCardWorker(
  ticketWorker: string | null,
  handover: string | null,
  repoWorker: string | null,
  defaultWorker: string,
): string {
  for (const value of [ticketWorker, handover === null ? null : parseHandover(handover).worker, repoWorker]) {
    if (value !== null && value.trim() !== '') {
      return value;
    }
  }
  return defaultWorker;
}

/** One work repo from `tickets/_meta/repos.md`. */
export interface RepoRef {
  readonly name: string;
  readonly url: string;
  readonly branch: string | null;
  readonly policy: string | null;
  /** Local checkout / worktree to open for testing (T-0004); the clone
   *  URL stays `url`. Null when not configured. */
  readonly path: string | null;
  /** The repo's default fleet worker (`worker: opencode`), or null. */
  readonly worker: string | null;
}

export interface BoardColumn {
  readonly phase: PipelinePhase;
  /** Final order: pins first (listed order), then derived order. */
  readonly tickets: readonly TicketCard[];
  /** The phase's directory exists with tickets, but pipeline.md lost it. */
  readonly unknown: boolean;
}

/** The whole board, rebuilt from files on every fetch — no stored state. */
export interface BoardSnapshot {
  readonly vaultId: string | null;
  readonly vaultName: string | null;
  /** Display name of the active vault — the empty state's initialize hint. */
  readonly activeVaultName: string | null;
  /** False when the tickets vault is not a git repo (transitions unversioned). */
  readonly isGitRepo: boolean;
  /** The configured default fleet worker (M84). */
  readonly defaultWorker: string;
  readonly pipeline: readonly PipelinePhase[];
  readonly pipelineError: string | null;
  /** pipeline.md's optional `push:` remote (T-0041); null = never push. */
  readonly pushRemote: string | null;
  readonly repos: readonly RepoRef[];
  readonly reposError: string | null;
  readonly columns: readonly BoardColumn[];
  /** Board-level findings (pipeline/repos/order files). */
  readonly issues: readonly TicketIssue[];
}

/** `true` when the id parses AND matches the file stem it came from. */
export function isValidTicketFile(name: string): boolean {
  return /^T-\d{4,}\.md$/.test(name);
}

/** Next free id: max existing + 1 — ids are never reused (burned in git). */
export function nextTicketId(existing: readonly string[]): string {
  let max = 0;
  for (const id of existing) {
    const match = /^T-(\d+)$/.exec(id);
    if (match !== null) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `T-${String(max + 1).padStart(4, '0')}`;
}

/** Result of every mutation IPC call (`create` / `transition` / `reorder` /
 *  `claim` / `initialize`): `ok` with an optional warning line the panel
 *  shows, or a refusal with the reason. */
export interface MutationResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly warning?: string;
}

/** `create`'s success result: the minted id and the new file's path, so
 *  the caller can open the pre-filled ticket in the editor (T-0001). */
export interface CreateResult extends MutationResult {
  readonly id?: string;
  readonly path?: string;
}

/** Short human age of an ISO stamp ("3m", "2h", "4d"); '' when unreadable. */
export function ageOf(iso: string | null, now: number = Date.now()): string {
  if (iso === null) {
    return '';
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return '';
  }
  const minutes = Math.floor((now - t) / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

/** The panel header's status value: open tickets (not in the last phase). */
export function openTicketCount(snapshot: BoardSnapshot): number {
  if (snapshot.columns.length === 0) {
    return 0;
  }
  const last = snapshot.columns[snapshot.columns.length - 1]!.phase.id;
  return snapshot.columns.reduce(
    (n, col) => n + (col.phase.id === last ? 0 : col.tickets.length),
    0,
  );
}
