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

const LIVE: ReadonlySet<RunState> = new Set(['starting', 'running', 'stopping', 'detached']);

export type WorkGroupId = 'needs' | 'shaping' | 'running' | 'ideas' | 'done';

export interface WorkRow {
  readonly card: TicketCard;
  /** The phase the ticket sits in (an unknown directory carries its own). */
  readonly phase: PipelinePhase;
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
 * Ideas: priority first, newest first within one (owner, 2026-10-31).
 * "New" is the capture stamp — `entered-<first phase>`, the ticket's
 * creation (a revived one carries its revival there).
 */
function ideaOrder(firstPhaseId: string): (a: WorkRow, b: WorkRow) => number {
  return (a, b) => {
    const byPriority = priorityWeight(a.card.meta.priority) - priorityWeight(b.card.meta.priority);
    if (byPriority !== 0) {
      return byPriority;
    }
    const at = a.card.meta.entered[firstPhaseId] ?? '';
    const bt = b.card.meta.entered[firstPhaseId] ?? '';
    if (at !== bt) {
      return at < bt ? 1 : -1;
    }
    return a.card.id < b.card.id ? 1 : a.card.id > b.card.id ? -1 : 0;
  };
}

export function workGroups(board: BoardSnapshot, runs: readonly RunInfo[]): WorkGroups {
  const configured = board.columns.filter((column) => !column.unknown);
  const pipeline = configured.map((column) => column.phase);
  const firstPhaseId = pipeline[0]?.id ?? '';
  const ideaIds = new Set(ideaPhaseIds(pipeline));
  const terminal = pipeline.length > 0 ? pipeline[pipeline.length - 1]!.id : null;

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
  ideas.sort(ideaOrder(firstPhaseId));
  // Shaping and Running: closest to done first (finishing beats
  // starting), then the column's own derived order.
  const byProgress = (a: { position: number; index: number }, b: { position: number; index: number }): number =>
    a.position !== b.position ? b.position - a.position : a.index - b.index;
  shaping.sort(byProgress);
  running.sort(byProgress);

  return {
    needs,
    shaping: shaping.map((entry) => entry.row),
    running: running.map((entry) => entry.row),
    ideas,
  };
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
