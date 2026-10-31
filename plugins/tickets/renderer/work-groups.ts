/**
 * The Work panel's groups (req-74 W1, ADR-0087): the board snapshot and
 * the fleet's runs folded into three lists — **Needs you** (everything
 * that waits on the owner), **Ideas** (the backlog before the machine)
 * and **In progress** (the rest up to the terminal phase). Pure, so the
 * panel and its specs share it; the phases stay the storage format and
 * are only shown as a row's status.
 *
 * Every ticket lands in exactly one group: Needs you wins.
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

export type WorkGroupId = 'needs' | 'ideas' | 'progress';

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
  readonly ideas: readonly WorkRow[];
  readonly progress: readonly WorkRow[];
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
  const progress: { row: WorkRow; position: number; index: number }[] = [];
  for (const { card, column, index } of placed.values()) {
    if (seen.has(card.id)) {
      continue;
    }
    if (ideaIds.has(column.phase.id)) {
      ideas.push(row(card, column, null));
      continue;
    }
    // Unknown directories sort after every configured phase.
    const position = column.unknown ? -1 : pipeline.findIndex((phase) => phase.id === column.phase.id);
    progress.push({ row: row(card, column, null), position, index });
  }
  ideas.sort(ideaOrder(firstPhaseId));
  // In progress: closest to done first (finishing beats starting), then
  // the column's own derived order.
  progress.sort((a, b) => (a.position !== b.position ? b.position - a.position : a.index - b.index));

  return { needs, ideas, progress: progress.map((entry) => entry.row) };
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

/** The one line under a row's title: why it waits, or where it stands. */
export function statusLineOf(row: WorkRow, board: BoardSnapshot): string {
  const need = row.need;
  if (need !== null) {
    switch (need.kind) {
      case 'question':
        return `Asks: ${need.text}`;
      case 'permission':
        return `Wants to: ${need.text}`;
      case 'red-gate':
        return `Gate red: ${need.text}`;
      case 'failed':
        return `Run failed: ${need.text}`;
      default: {
        const action = checkpointActionOf(board, need.phase);
        return action.kind === 'accept' ? 'Done — accept it into the archive' : `${row.phase.title} — waits for your review`;
      }
    }
  }
  if (row.card.blocked.length > 0) {
    return `Blocked by ${row.card.blocked.join(', ')}`;
  }
  if (row.run !== null) {
    return `${row.phase.title} — ${row.run.provider} ${row.run.state === 'detached' ? 'detached' : 'working'}`;
  }
  if (row.queued) {
    return 'Queued for the fleet';
  }
  if (row.card.meta.parkedReason !== null) {
    return `Parked: ${row.card.meta.parkedReason}`;
  }
  return row.phase.title;
}
