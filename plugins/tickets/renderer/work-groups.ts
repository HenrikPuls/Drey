/**
 * The Work panel's groups (req-75 W1, W1b; ADR-0087): the board snapshot
 * and the fleet's runs folded into four lists — **Needs you** (everything
 * that waits on the owner), **Shaping** (the interactive dialogs), **Running**
 * (the rest on its way through the pipeline) and **Ideas** (the backlog
 * before the machine). Pure, so the panel and its specs share it; the
 * phases stay the storage format and are only shown as a row's status.
 *
 * Every ticket lands in exactly one group: Needs you wins, then Shaping.
 * The Done-this-week group is not built here — it comes from the
 * snapshot's `recentDone` (archived tickets), which the panel draws.
 *
 * Every row carries its phase's colour (T-0084): `phaseColor`, from the
 * phase's `color:` in pipeline.md or the default palette by position —
 * the panel draws it as the row's phase chip.
 */
import type { NeedItem } from '../shared/remote-protocol';
import {
  parseHandover,
  priorityWeight,
  type BoardColumn,
  type BoardSnapshot,
  type PipelinePhase,
  type TicketCard,
} from '../shared/tickets';
import type { RunInfo, RunState } from '../main/fleet/protocol';
import { needsOf } from '../main/remote/needs';
import { phaseColorOf } from './phase-colors';

const LIVE: ReadonlySet<RunState> = new Set(['starting', 'running', 'stopping', 'detached']);

export type WorkGroupId = 'needs' | 'shaping' | 'running' | 'ideas' | 'done';

export interface WorkRow {
  readonly card: TicketCard;
  /** The phase the ticket sits in (an unknown directory carries its own). */
  readonly phase: PipelinePhase;
  /** The phase chip's colour — explicit `color:` or the default palette (T-0084). */
  readonly phaseColor: string;
  /** Why the owner is needed; null outside Needs you. */
  readonly need: NeedItem | null;
  /** An idea already in a queue the fleet pulls from (Ideas only). */
  readonly queued: boolean;
  /** The ticket's live run, if any. */
  readonly run: RunInfo | null;
}

export interface WorkGroups {
  readonly needs: readonly WorkRow[];
  readonly shaping: readonly WorkRow[];
  readonly running: readonly WorkRow[];
  readonly ideas: readonly WorkRow[];
}

/** A phase the machine works: an agent pool or a CI check. */
export function isMachinePhase(phase: PipelinePhase): boolean {
  const mode = parseHandover(phase.handover).mode;
  return mode === 'agent' || mode === 'ci';
}

/**
 * The phases whose tickets are ideas: the first phase plus every manual
 * phase before the first machine phase. With no machine phase at all
 * only the first phase holds ideas.
 */
export function ideaPhaseIds(pipeline: readonly PipelinePhase[]): readonly string[] {
  const firstMachine = pipeline.findIndex(isMachinePhase);
  if (firstMachine < 0) {
    return pipeline.length > 0 ? [pipeline[0]!.id] : [];
  }
  return pipeline.slice(0, Math.max(1, firstMachine)).map((phase) => phase.id);
}

/**
 * Where "Queue for the fleet" moves an idea: the last idea phase (the
 * queue the first machine phase pulls from), or the first machine phase
 * itself when the ideas are just the first phase. Null when there is no
 * machine phase to queue for, or the ticket already sits there.
 */
export function queueTargetOf(pipeline: readonly PipelinePhase[], phaseId: string): string | null {
  const ideas = ideaPhaseIds(pipeline);
  const firstMachine = pipeline.find(isMachinePhase) ?? null;
  if (firstMachine === null) {
    return null;
  }
  const target = ideas.length > 1 ? ideas[ideas.length - 1]! : firstMachine.id;
  return target === phaseId ? null : target;
}

/** The newest live run of a ticket. */
export function liveRunOf(ticketId: string, runs: readonly RunInfo[]): RunInfo | null {
  let found: RunInfo | null = null;
  for (const run of runs) {
    if (run.ticketId === ticketId && LIVE.has(run.state) && (found === null || run.startedAt > found.startedAt)) {
      found = run;
    }
  }
  return found;
}

/**
 * What the Work list's DOM *structure* depends on (T-0086): per run,
 * sorted by id, the fields that move a ticket between groups or change
 * a row's bones — id, state, column, waiting kind, turn, interactive,
 * held — then the alert keys. `activity`, tokens and clocks change only
 * the *text* of nodes that already exist and stay out, so a fleet
 * update that moves nothing re-renders nothing.
 */
export function workListSignature(runs: readonly RunInfo[], alertKeys: readonly string[]): string {
  const perRun = [...runs]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((run) =>
      [
        run.id,
        run.state,
        run.phase ?? '',
        run.waiting?.kind ?? '',
        run.turn ?? '',
        run.interactive ?? '',
        run.held === true ? 'held' : '',
      ].join(':'),
    );
  return [...perRun, ...alertKeys].join('|');
}

/**
 * Ideas: priority first (through `dependencyOrder`, which also puts a
 * blocker first), newest first within one (owner, 2026-10-31). "New" is
 * the capture stamp — `entered-<first phase>`, the ticket's creation (a
 * revived one carries its revival there).
 */
function ideaRecency(firstPhaseId: string): (a: WorkRow, b: WorkRow) => number {
  return (a, b) => {
    const at = a.card.meta.entered[firstPhaseId] ?? '';
    const bt = b.card.meta.entered[firstPhaseId] ?? '';
    if (at !== bt) {
      return at < bt ? 1 : -1;
    }
    return a.card.id < b.card.id ? 1 : a.card.id > b.card.id ? -1 : 0;
  };
}

/**
 * Dependencies before priority (owner, 2026-10-31): a ticket never sorts
 * above an open blocker in the same list, and a blocker carries the most
 * urgent priority of everything it holds up, so a low ticket that blocks
 * an urgent one moves up with it — its own lower priority no longer
 * counts. Within one effective priority, `tieBreak` decides. A
 * dependency cycle cannot be ordered; its rows fall back to the key.
 */
export function dependencyOrder<T extends { readonly card: TicketCard }>(
  rows: readonly T[],
  tieBreak: (a: T, b: T) => number,
): T[] {
  const byId = new Map(rows.map((row) => [row.card.id, row]));
  const blockersOf = (row: T): string[] => row.card.blocked.filter((id) => id !== row.card.id && byId.has(id));
  // The most urgent weight among the row and everything it (transitively) blocks.
  const weight = new Map<string, number>();
  const effective = (id: string, seen: Set<string>): number => {
    const known = weight.get(id);
    if (known !== undefined) {
      return known;
    }
    const row = byId.get(id)!;
    let best = priorityWeight(row.card.meta.priority);
    seen.add(id);
    for (const dependent of row.card.blocks) {
      if (byId.has(dependent) && !seen.has(dependent)) {
        best = Math.min(best, effective(dependent, seen));
      }
    }
    seen.delete(id);
    weight.set(id, best);
    return best;
  };
  const key = (a: T, b: T): number => effective(a.card.id, new Set()) - effective(b.card.id, new Set()) || tieBreak(a, b);

  const remaining = new Map(rows.map((row) => [row.card.id, new Set(blockersOf(row))]));
  const out: T[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, blockers]) => blockers.size === 0).map(([id]) => byId.get(id)!);
    const pool = ready.length > 0 ? ready : [...remaining.keys()].map((id) => byId.get(id)!);
    const next = [...pool].sort(key)[0]!;
    out.push(next);
    remaining.delete(next.card.id);
    for (const blockers of remaining.values()) {
      blockers.delete(next.card.id);
    }
  }
  return out;
}

export function workGroups(board: BoardSnapshot, runs: readonly RunInfo[]): WorkGroups {
  const configured = board.columns.filter((column) => !column.unknown);
  const pipeline = configured.map((column) => column.phase);
  const firstPhaseId = pipeline[0]?.id ?? '';
  const ideaIds = new Set(ideaPhaseIds(pipeline));
  const terminal = pipeline.length > 0 ? pipeline[pipeline.length - 1]!.id : null;

  // Chip colours keyed on the board position (T-0084): the configured
  // columns in pipeline order, unknown directories after them.
  const positionOf = new Map<string, number>();
  configured.forEach((column, index) => positionOf.set(column.phase.id, index));
  let afterConfigured = configured.length;
  for (const column of board.columns) {
    if (column.unknown && !positionOf.has(column.phase.id)) {
      positionOf.set(column.phase.id, afterConfigured++);
    }
  }

  const placed = new Map<string, { card: TicketCard; column: BoardColumn; index: number }>();
  board.columns.forEach((column) => {
    column.tickets.forEach((card, index) => {
      if (!placed.has(card.id)) {
        placed.set(card.id, { card, column, index });
      }
    });
  });

  const row = (card: TicketCard, column: BoardColumn, need: NeedItem | null): WorkRow => ({
    card,
    phase: column.phase,
    phaseColor: phaseColorOf(column.phase, positionOf.get(column.phase.id) ?? 0),
    need,
    queued: need === null && ideaIds.has(column.phase.id) && column.phase.id !== firstPhaseId,
    run: liveRunOf(card.id, runs),
  });

  // Needs you: the remote's list (questions, approvals, red gates, failed
  // runs, checkpoints), plus every ticket in the terminal phase — the
  // owner accepts it into the archive. One row per ticket, first reason wins.
  const needs: WorkRow[] = [];
  const seen = new Set<string>();
  for (const need of needsOf(board, runs)) {
    const at = placed.get(need.ticketId);
    if (at === undefined || seen.has(need.ticketId)) {
      continue;
    }
    seen.add(need.ticketId);
    needs.push(row(at.card, at.column, need));
  }
  if (terminal !== null) {
    const column = configured[configured.length - 1]!;
    for (const card of column.tickets) {
      if (seen.has(card.id)) {
        continue;
      }
      seen.add(card.id);
      needs.push(
        row(card, column, {
          kind: 'checkpoint',
          ticketId: card.id,
          title: card.meta.title ?? card.id,
          phase: terminal,
          runId: null,
          text: '',
          since: card.meta.entered[terminal] ?? null,
        }),
      );
    }
  }

  const ideas: WorkRow[] = [];
  const shaping: { row: WorkRow; position: number; index: number }[] = [];
  const running: { row: WorkRow; position: number; index: number }[] = [];
  for (const { card, column, index } of placed.values()) {
    if (seen.has(card.id)) {
      continue;
    }
    // Shaping: the owner works this ticket in an interactive dialog —
    // the reservation stands or a live dialog run carries it.
    if (card.meta.interactive || liveRunOf(card.id, runs)?.interactive !== undefined) {
      const position = column.unknown ? -1 : pipeline.findIndex((phase) => phase.id === column.phase.id);
      shaping.push({ row: row(card, column, null), position, index });
      continue;
    }
    if (ideaIds.has(column.phase.id)) {
      ideas.push(row(card, column, null));
      continue;
    }
    // Unknown directories sort after every configured phase.
    const position = column.unknown ? -1 : pipeline.findIndex((phase) => phase.id === column.phase.id);
    running.push({ row: row(card, column, null), position, index });
  }
  // Shaping: closest to done first (finishing beats starting), then the
  // column's own derived order.
  const byProgress = (a: { position: number; index: number }, b: { position: number; index: number }): number =>
    a.position !== b.position ? b.position - a.position : a.index - b.index;
  shaping.sort(byProgress);
  // Running (owner, 2026-10-31): the tickets with a live run on top, then
  // the queue — dependencies first, then priority, then closest to done.
  type Placed = { row: WorkRow; card: TicketCard; position: number; index: number };
  const placedRunning: Placed[] = running.map((entry) => ({ ...entry, card: entry.row.card }));
  const live = placedRunning
    .filter((entry) => entry.row.run !== null)
    .sort((a, b) => priorityWeight(a.card.meta.priority) - priorityWeight(b.card.meta.priority) || byProgress(a, b));
  const queued = dependencyOrder(
    placedRunning.filter((entry) => entry.row.run === null),
    byProgress,
  );

  return {
    needs,
    shaping: shaping.map((entry) => entry.row),
    running: [...live, ...queued].map((entry) => entry.row),
    ideas: dependencyOrder(ideas, ideaRecency(firstPhaseId)),
  };
}

/** A row's derived status (T-0084, grafted onto the canvas groups): the
 *  filter's vocabulary and the head counts read it. A need decides first
 *  — waiting, failed or review; then a live run means running; an open
 *  blocked-by edge means blocked; what the fleet will take (the ideas'
 *  queue, a machine phase without a run) is queued; a parked one is
 *  parked; everything else is idle. The phone's own Needs-you list
 *  keeps its kind order (`needsOf` is its contract). */
export type WorkStatus = 'waiting' | 'failed' | 'running' | 'queued' | 'blocked' | 'parked' | 'review' | 'idle';

export function rowStatusOf(row: WorkRow): WorkStatus {
  const need = row.need;
  if (need !== null) {
    if (need.kind === 'question' || need.kind === 'permission') {
      return 'waiting';
    }
    if (need.kind === 'red-gate' || need.kind === 'failed') {
      return 'failed';
    }
    return 'review';
  }
  if (row.run !== null) {
    return 'running';
  }
  if (row.card.blocked.length > 0) {
    return 'blocked';
  }
  if (row.queued || isMachinePhase(row.phase)) {
    return 'queued';
  }
  if (row.card.meta.parkedReason !== null) {
    return 'parked';
  }
  return 'idle';
}

/** What a checkpoint asks of the owner: approve into the next phase, or accept into the archive. */
export type CheckpointAction =
  | { readonly kind: 'approve'; readonly to: string; readonly label: string }
  | { readonly kind: 'accept'; readonly label: string };

export function checkpointActionOf(board: BoardSnapshot, phaseId: string): CheckpointAction {
  const configured = board.columns.filter((column) => !column.unknown);
  const index = configured.findIndex((column) => column.phase.id === phaseId);
  const next = index >= 0 ? configured[index + 1] : undefined;
  if (next === undefined) {
    return { kind: 'accept', label: 'Accept' };
  }
  return { kind: 'approve', to: next.phase.id, label: `Approve → ${next.phase.title}` };
}

/** The kind chip of a Needs-you row (req-75 W1b): one short word for why. */
export function needKindLabel(need: NeedItem, board: BoardSnapshot): string {
  switch (need.kind) {
    case 'question':
      return 'Question';
    case 'permission':
      return 'Approval';
    case 'red-gate':
      return 'Gate red';
    case 'failed':
      return 'Run failed';
    default: {
      const configured = board.columns.filter((column) => !column.unknown);
      const index = configured.findIndex((column) => column.phase.id === need.phase);
      // The terminal phase holds a result to try; a checkpoint right
      // after the plan column holds a plan to approve.
      if (index === configured.length - 1) {
        return 'Ready to try';
      }
      const firstMachine = configured.findIndex((column) => isMachinePhase(column.phase));
      return index - 1 === firstMachine ? 'Plan to approve' : 'Review';
    }
  }
}

/** One Running row's second line: the step word and what the worker does. */
export interface RunningStep {
  readonly step: string;
  readonly line: string;
  readonly live: boolean;
}

export function runningStepOf(row: WorkRow, board: BoardSnapshot): RunningStep {
  const run = row.run;
  if (run !== null) {
    const title = board.columns.find((c) => c.phase.id === row.phase.id)?.phase.title ?? row.phase.title;
    const step =
      row.phase.id === 'plan' ? 'Planning' : row.phase.id === 'build' ? 'Building' : row.phase.id === 'commit' ? 'Merging' : title;
    return { step, line: (run.activity ?? '').trim(), live: true };
  }
  const blocker = row.card.blocked[0];
  if (blocker === undefined) {
    return { step: 'Queued', line: 'waits for a free worker', live: false };
  }
  const title =
    board.columns.flatMap((column) => column.tickets).find((card) => card.id === blocker)?.meta.title ?? blocker;
  return { step: 'Queued', line: `waits for “${title}”`, live: false };
}

/** A stamp as the rows show it: `now`, `4 min`, `3 h`, `yesterday`, `2 d`. */
export function ageWords(iso: string | null, nowMs: number): string {
  if (iso === null) {
    return '';
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return '';
  }
  const minutes = Math.floor((nowMs - t) / 60_000);
  if (minutes < 1) {
    return 'now';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h`;
  }
  if (hours < 48) {
    return 'yesterday';
  }
  return `${Math.floor(hours / 24)} d`;
}

/** The muted line after a Needs-you row's kind chip: why it waits. */
export function statusLineOf(row: WorkRow, board: BoardSnapshot): string {
  const need = row.need;
  if (need === null) {
    return '';
  }
  switch (need.kind) {
    case 'question': {
      // A shaped question (req-75 W2) reads as its question, not the blob.
      const shaped = row.run?.waiting?.shaped ?? null;
      return shaped === null ? need.text : shaped.question;
    }
    case 'permission':
    case 'red-gate':
    case 'failed':
      return need.text;
    default: {
      switch (needKindLabel(need, board)) {
        case 'Ready to try':
          // `<n> files · checks green` is W3's; until then the checks say it.
          return 'checks green';
        case 'Plan to approve':
          return 'plan ready';
        default:
          return 'waits for your review';
      }
    }
  }
}
