/**
 * Stateless drift detection — "a file move is a ticket move" (T-0041,
 * ADR-0076 later change). Pure, no IO: files in, drift out.
 *
 * A ticket file moved between phase folders outside the board (Explorer,
 * Files panel) must receive exactly the treatment a board move gives it.
 * The detector derives that need from the files alone — nothing else — so
 * it survives restarts and re-runs safely: the treatment makes
 * `entered-<to>` the newest event, which is precisely the predicate's
 * fixpoint (keep this file and the patch in `index.ts` in sync).
 *
 * The consistency predicate (owner decision, 2026-10-19):
 *
 * - In a known phase B, a ticket with parseable frontmatter and no live
 *   `run:` map needs treatment ⟺ `entered-<B>` is missing or older than
 *   the newest of (all `entered-*` stamps, the archived marker). `from`
 *   is the holder of that newest event — `'archive'` when the marker
 *   dominates, `null` when no event exists at all (a hand-created file;
 *   the treatment logs it as `unknown`).
 * - In `tickets/archive/`, treatment ⟺ no `— archived` Log marker newer
 *   than every `entered-*` stamp. The marker — NOT an
 *   `entered-archive` key — is what makes archival idempotent and a
 *   revive-then-re-archive detectable; body edits after archiving never
 *   re-fire.
 *
 * Skipped, deliberately: files whose frontmatter does not parse or whose
 * parse produced an error-level finding (the board badges them; an
 * ambiguous file is never guessed at), tickets carrying a live `run:`
 * map (the fleet runner owns the file mid-move), directories that are
 * not pipeline phases (an unknown column is a badge, not a move) and
 * `_meta`. Human moves are logged, never blocked — lane rules stay
 * runner-only.
 */
import { TICKETS_ARCHIVE_DIR, type PipelinePhase, type RecentDone } from '../shared/tickets';
import { parseTicketFile, ticketPathParts } from './ticket-files';

/** The newest machine-shaped archive marker —
 *  `- '<stamp>' <who> — archived` — or null when the Log has none. */
export function parseArchivedStamp(text: string): string | null {
  let newest: string | null = null;
  for (const rawLine of text.split('\n')) {
    const match = /^-\s'([^']+)'.*—\sarchived\s*$/.exec(rawLine.trimEnd());
    if (match !== null && (newest === null || compareStamps(match[1]!, newest) > 0)) {
      newest = match[1]!;
    }
  }
  return newest;
}

/** How long a ticket stays in the Done-this-week group (req-75 W1b). */
const RECENT_DONE_MS = 7 * 24 * 60 * 60 * 1000;

/** At most this many rows in the Done-this-week group. */
const RECENT_DONE_MAX = 20;

/**
 * The Done-this-week rows (req-75 W1b): every `tickets/archive/*.md`
 * whose newest `— archived` Log stamp lies within the last 7 days,
 * newest first, at most 20 (stamp ties break by id). Pure — the board
 * service feeds it the file list it read anyway, so a refresh costs no
 * extra reads.
 */
export function recentDoneOf(
  files: readonly { readonly path: string; readonly text: string }[],
  nowMs: number,
): RecentDone[] {
  const prefix = `${TICKETS_ARCHIVE_DIR}/`;
  const found: { id: string; title: string | null; at: string; t: number }[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix) || !file.path.endsWith('.md') || file.path.slice(prefix.length).includes('/')) {
      continue;
    }
    const at = parseArchivedStamp(file.text);
    if (at === null) {
      continue;
    }
    const t = Date.parse(at);
    if (Number.isNaN(t) || nowMs - t > RECENT_DONE_MS) {
      continue;
    }
    found.push({
      id: file.path.slice(prefix.length, -'.md'.length),
      title: parseTicketFile(file.text, file.path).meta.title,
      at,
      t,
    });
  }
  return found
    .sort((a, b) => (a.t !== b.t ? b.t - a.t : a.id < b.id ? -1 : 1))
    .slice(0, RECENT_DONE_MAX)
    .map(({ id, title, at }) => ({ id, title, at }));
}

/** One drift the board's normalization owes a full transition treatment. */
export interface DriftDetection {
  readonly kind: 'move' | 'archive';
  readonly id: string;
  /** The file's path as it sits — a treatment changes stamps, Log and pins, never the path. */
  readonly path: string;
  /** The directory as written (`10-inbox`); `'archive'` for kind 'archive'. */
  readonly phaseDir: string;
  /** The prefix-stripped phase id; `'archive'` for kind 'archive'. */
  readonly phase: string;
  /** Derived previous phase, `'archive'`, or null (no event at all — logged as `unknown`). */
  readonly from: string | null;
}

export interface DriftFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Every file whose state disagrees with where it sits. Deterministic:
 * the same files and pipeline always produce the same detections, in
 * file order.
 */
export function detectDrift(
  files: readonly DriftFile[],
  pipeline: readonly PipelinePhase[],
): readonly DriftDetection[] {
  const phaseIds = new Set(pipeline.map((phase) => phase.id));
  const drifts: DriftDetection[] = [];
  for (const file of files) {
    const parts = ticketPathParts(file.path);
    if (parts === null || parts.phaseDir === '_meta') {
      continue; // not a ticket file; the board badges strays separately
    }
    const parsed = parseTicketFile(file.text, file.path);
    if (parsed.issues.some((issue) => issue.level === 'error')) {
      continue; // ambiguous files are never guessed at
    }
    if (parsed.meta.run !== null) {
      continue; // the fleet runner owns the file mid-move
    }

    const newestEntered = newestStampOf(parsed.meta.entered);
    if (file.path.startsWith(`${TICKETS_ARCHIVE_DIR}/`)) {
      const archived = parseArchivedStamp(file.text);
      const consistent =
        archived !== null && (newestEntered === null || compareStamps(archived, newestEntered.stamp) > 0);
      if (consistent) {
        continue;
      }
      drifts.push({
        kind: 'archive',
        id: parts.stem,
        path: file.path,
        phaseDir: parts.phaseDir,
        phase: 'archive',
        from: newestEntered?.phase ?? null,
      });
      continue;
    }

    if (!phaseIds.has(parts.phase)) {
      continue; // unknown directory: a badge, not a move
    }
    const archived = parseArchivedStamp(file.text);
    let from: string | null = newestEntered?.phase ?? null;
    let newestStamp = newestEntered?.stamp ?? '';
    if (archived !== null && (newestStamp === '' || compareStamps(archived, newestStamp) > 0)) {
      from = 'archive';
      newestStamp = archived;
    }
    const enteredHere = parsed.meta.entered[parts.phase];
    const consistent =
      enteredHere !== undefined && (newestStamp === '' || compareStamps(enteredHere, newestStamp) >= 0);
    if (consistent) {
      continue;
    }
    drifts.push({
      kind: 'move',
      id: parts.stem,
      path: file.path,
      phaseDir: parts.phaseDir,
      phase: parts.phase,
      from,
    });
  }
  return drifts;
}

/** The newest `entered-*` stamp with its phase, or null when there is none. */
function newestStampOf(entered: Readonly<Record<string, string>>): { phase: string; stamp: string } | null {
  let best: { phase: string; stamp: string } | null = null;
  for (const [phase, stamp] of Object.entries(entered)) {
    if (best === null || compareStamps(stamp, best.stamp) > 0) {
      best = { phase, stamp };
    }
  }
  return best;
}

/** Stamp comparison: epoch when both parse as dates, else lexicographic. */
function compareStamps(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) {
    return ta < tb ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
