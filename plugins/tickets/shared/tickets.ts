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
  /**
   * The PRIMARY work repo — where the fleet's gate runs and whose
   * worktree is the run's home. `repos[0]` when the ticket names more
   * than one (req-72); null = no repo.
   */
  readonly repo: string | null;
  /**
   * Every work repo the ticket touches, primary first (req-72). Read
   * from the `repos:` list, else from legacy `repo:`; empty = no repo.
   * The fleet prepares one worktree per repo, all on the ticket branch;
   * the brief lists the extra ones with their absolute checkouts.
   */
  readonly repos: readonly string[];
  /** The ticket's worker pin (`worker: opencode`); null = not pinned. */
  readonly worker: string | null;
  readonly priority: TicketPriority;
  readonly rank: number;
  readonly branch: string | null;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly run: TicketRun | null;
  readonly references: readonly string[];
  /**
   * The `blocked-by:` ids as written (T-0050): never resolved or
   * filtered here — the dependency pass turns them into the derived
   * `blocked` state; empty = the field is absent.
   */
  readonly blockedBy: readonly string[];
  readonly parkedReason: string | null;
  readonly parkedAt: string | null;
  /**
   * The owner reserved this ticket for an interactive dialog (req-65):
   * `interactive: true` in the frontmatter. The dispatcher keeps its
   * hands off (the fleet never pulls the ticket) while the field stands;
   * a board move drops it.
   */
  readonly interactive: boolean;
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
  /** The resolved fleet worker for this card (M84 display resolution). */
  readonly worker: string;
  /**
   * The OPEN blockers (T-0050): referenced ids that have not reached the
   * terminal phase, unknown ids included; `[]` = unblocked. Derived on
   * every board assembly, never stored.
   */
  readonly blocked: readonly string[];
  /** The derived inverse: ids currently blocked by this card (open edges). */
  readonly blocks: readonly string[];
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
  /**
   * The column's worker pin (`worker: opencode`, M85) — the assignment
   * ring's column level; unset on a hand-edited manual column.
   */
  readonly worker: string | null;
  /** The column's model pin (`model: zai/glm-5.3`, M85); null = unset. */
  readonly model: string | null;
  /** Explicit prompt ref override (`prompt: plan-heavy`, M85); null = handover ref. */
  readonly prompt: string | null;
  /**
   * The interactive dialog's prompt ref (`interactive: plan-interview`,
   * req-65) — the brief an interactive run in this column gets; null =
   * the shipped defaults (`plan-interactive-default` on the plan column,
   * `refine-interactive-default` at the checkpoints).
   */
  readonly interactive: string | null;
  /**
   * The circuit breaker's threshold (`max-red:`, M85): consecutive red
   * gates the column tolerates before it trips. Default 3.
   */
  readonly maxRed: number | null;
  /**
   * The column's daily token budget (`token-budget:`, M85); null = off.
   * Summed over the runs the pool settles per day.
   */
  readonly tokenBudget: number | null;
  /**
   * The ci handover's check command (`ci:`, M85): a green run moves the
   * ticket one column right — the machine gate in the work repo.
   */
  readonly ci: string | null;
  /**
   * The sampling audit's fraction (`audit:`, M85, 0–1; default off): a
   * green step is sampled and a second worker reviews it before the
   * move. The live trial decides whether the rung stays.
   */
  readonly audit: number | null;
  /**
   * The semantic gate (`semantic: true`, M85; default off): every green
   * step in the column gets a second worker's review before it moves.
   */
  readonly semantic: boolean;
}

/** The default for a phase entry that omits the M85 pool keys —
 *  explicit values win over the defaults. */
export function phaseWithoutPoolKeys(
  phase: Partial<PipelinePhase> & Pick<PipelinePhase, 'id' | 'title' | 'wip' | 'claim' | 'handover'>,
): PipelinePhase {
  return {
    worker: null,
    model: null,
    prompt: null,
    interactive: null,
    maxRed: null,
    tokenBudget: null,
    ci: null,
    audit: null,
    semantic: false,
    ...phase,
  };
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
  /**
   * The repo's worktree base override (`worktrees:`, T-0044): where the
   * fleet's checkouts for this repo live — `<base>/<ticket-id>`.
   * Absolute, or relative to the tickets repo root. Null = the default
   * `<ticketsRepo>/_worktrees` (ADR-0080).
   */
  readonly worktrees: string | null;
  /** Git-ignored folders a fleet worktree links from the checkout (`link:`, req-56); absent = none. */
  readonly link?: readonly string[];
}

export interface BoardColumn {
  readonly phase: PipelinePhase;
  /** Derived order: priority, rank, entered-<phase>, id. */
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
  /** Board-level findings (pipeline/repos files). */
  readonly issues: readonly TicketIssue[];
  /**
   * The owner's checkpoint columns (M85): manual columns between
   * automatic ones — the machine never pulls across them; the owner's
   * moves feed the next pool.
   */
  readonly checkpoints: readonly string[];
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

/** The ids of the archived tickets among vault-relative paths — minting
 *  counts them, so an archived id is never handed out again. */
export function archivedTicketIds(paths: readonly string[]): string[] {
  const prefix = `${TICKETS_ARCHIVE_DIR}/`;
  return paths
    .filter((p) => p.startsWith(prefix) && p.endsWith('.md') && !p.slice(prefix.length).includes('/'))
    .map((p) => p.slice(prefix.length, -'.md'.length));
}

/** Result of every mutation IPC call (`create` / `transition` / `reorder` /
 *  `claim` / `initialize`): `ok` with an optional warning line the panel
 *  shows, or a refusal with the reason. */
export interface MutationResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly warning?: string;
  /** Reorder / "Number folders" (req-50): how many folders were renamed. */
  readonly moved?: number;
  /**
   * A move's final vault-relative path (`transition` / `archive` /
   * `unarchive`, T-0042): the Files panel re-keys open tabs to it when
   * the plugin performed the move as a structured action.
   */
  readonly path?: string;
}

/** One file of `tickets/_meta/prompts/` as it is on disk (req-50). */
export interface PromptEntry {
  readonly ref: string;
  readonly text: string;
  /** Drey ships a prompt of this name, so "Reset to the shipped version" applies. */
  readonly shipped: boolean;
}

/** The settings page's prompt list: the folder's files and nothing else. */
export interface PromptListing {
  /** Absolute path of `tickets/_meta/prompts/`; null without a tickets vault. */
  readonly folder: string | null;
  readonly entries: readonly PromptEntry[];
  /** Every prompt name Drey ships (the "Add Drey's prompts" offer). */
  readonly shipped: readonly string[];
}

/** One work repo a folder scan found (req-72): the "Add from folder" seed. */
export interface RepoCandidate {
  readonly name: string;
  /** The origin remote's URL; null when the checkout has none. */
  readonly url: string | null;
  readonly branch: string | null;
  /** Absolute local checkout. */
  readonly path: string;
}

/** The settings page's repositories listing: `repos.md` as it is on disk. */
export interface ReposListing {
  /** Absolute path of `tickets/_meta/repos.md`; null without a tickets vault. */
  readonly file: string | null;
  readonly repos: readonly RepoRef[];
  readonly error: string | null;
}

/** One tickets vault that carries a board (req-72): a project. */
export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly active: boolean;
}

/** Whether the phase folders carry their derived numbers (T-0041, req-50). */
export interface FolderStatus {
  /** Absolute path of `tickets/`; null without a tickets vault. */
  readonly root: string | null;
  /** The renames "Number folders" would make; empty = numbered. */
  readonly moves: readonly { readonly from: string; readonly to: string }[];
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
