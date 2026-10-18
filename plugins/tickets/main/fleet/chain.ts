/**
 * The chain's pure planning core (M85, ADR-0077): which columns run
 * themselves, where the owner's checkpoints sit, and what the
 * orchestrator dispatches next. No IO — the runner and the specs feed
 * it assembled board columns and the persisted control state.
 *
 * The rules, in the owner's words:
 * - A column with a worker (handover `agent …`) drains itself; a column
 *   without one is a manual step — the human moves its tickets.
 * - A pool serves its own queue first (refinement rounds the owner
 *   moved back), then tops up from the previous column's top — so the
 *   plan pool drains `prioritized` without a worker of its own.
 * - A manual column that sits between automatic columns is the owner's
 *   **checkpoint** (plan-review in the live default): the machine never
 *   pulls across it — the owner's forward move is what feeds the next
 *   pool. A manual column *before* the first automatic one is a plain
 *   queue and is fair game.
 * - The agent's finished turn is its completion declaration; the runner
 *   still re-runs the machine gate — agent-done AND green gate moves
 *   the ticket one column right, a red gate parks it (the ticket stays,
 *   the failure is logged).
 */
import {
  parseHandover,
  type BoardColumn,
  type PipelinePhase,
  type TicketCard,
} from '../../shared/tickets';
import type { ChainMaster, ColumnMode } from './protocol';

/** True when the column's handover hands tickets to an agent pool. */
export function isAutoPhase(phase: PipelinePhase): boolean {
  return parseHandover(phase.handover).mode === 'agent';
}

/** The column's worker pin: the `worker:` key, else the handover's `@worker`. */
export function columnWorkerPin(phase: PipelinePhase): string | null {
  if (phase.worker !== null && phase.worker.trim() !== '') {
    return phase.worker;
  }
  return parseHandover(phase.handover).worker;
}

/** The column's prompt ref: the `prompt:` key, else the handover's ref. */
export function columnPromptRef(phase: PipelinePhase): string | null {
  if (phase.prompt !== null && phase.prompt.trim() !== '') {
    return phase.prompt;
  }
  return parseHandover(phase.handover).promptRef;
}

/**
 * The ids of the owner's checkpoint columns: manual columns whose
 * predecessor is automatic. The dispatcher never pulls across one —
 * only the owner's moves cross it (refine / implement / park).
 */
export function checkpointPhaseIds(columns: readonly BoardColumn[]): ReadonlySet<string> {
  const checkpoints = new Set<string>();
  for (let i = 1; i < columns.length; i++) {
    const phase = columns[i]!.phase;
    if (!isAutoPhase(phase) && isAutoPhase(columns[i - 1]!.phase)) {
      checkpoints.add(phase.id);
    }
  }
  return checkpoints;
}

/** The pipeline-next phase id of a column, or null on the last one. */
export function nextPhaseIdOf(columns: readonly BoardColumn[], phaseId: string): string | null {
  const index = columns.findIndex((c) => c.phase.id === phaseId);
  if (index < 0 || index + 1 >= columns.length) {
    return null;
  }
  return columns[index + 1]!.phase.id;
}

// ---------------------------------------------------------------------------
// The dispatch plan.

export interface PlanDispatchInput {
  readonly master: ChainMaster;
  /** Board columns in pipeline order; each column's tickets are already
   *  in column order (pins first, then derived). */
  readonly columns: readonly BoardColumn[];
  /** Per-column mode; a phase absent here is `playing`. */
  readonly modes: Readonly<Record<string, ColumnMode>>;
  /** Live (starting/running/stopping) run counts per working column. */
  readonly liveByColumn: Readonly<Record<string, number>>;
  /** Ticket ids that must not be dispatched (a live or detached run
   *  somewhere, or a run stamp without a supervised run). */
  readonly busyTickets: ReadonlySet<string>;
  /** Columns in cooldown until this ISO instant (a red gate's breather). */
  readonly cooldownUntil?: Readonly<Record<string, string>>;
  /** Now, for the cooldown comparison (epoch ms). */
  readonly nowMs?: number;
}

export interface PlannedDispatch {
  /** The pool that works the ticket (= the RunRequest's `column`). */
  readonly workingPhase: string;
  /** Where the ticket file sits now (a pull leaves it there until the move). */
  readonly fromPhase: string;
  readonly card: TicketCard;
}

/** A card the machine may take: unclaimed, unblemished, not already running. */
function dispatchable(card: TicketCard, busyTickets: ReadonlySet<string>): boolean {
  if (busyTickets.has(card.id) || card.meta.run !== null || card.meta.claimedBy !== null) {
    return false;
  }
  return !card.issues.some((issue) => issue.level === 'error');
}

/**
 * What to dispatch right now, in dispatch order: per automatic, playing
 * column with a free slot and a move target — its own queue first, then
 * topped up from the previous column's top unless that column is
 * automatic (it dispatches its own) or an owner checkpoint.
 */
export function planDispatch(input: PlanDispatchInput): readonly PlannedDispatch[] {
  const plan: PlannedDispatch[] = [];
  if (input.master !== 'run') {
    return plan;
  }
  const checkpoints = checkpointPhaseIds(input.columns);
  const taken = new Set<string>();
  for (let i = 0; i < input.columns.length; i++) {
    const column = input.columns[i]!;
    const phase = column.phase;
    if (!isAutoPhase(phase) || nextPhaseIdOf(input.columns, phase.id) === null) {
      continue; // a manual step, or the terminal column has nothing to move into
    }
    if ((input.modes[phase.id] ?? 'playing') !== 'playing') {
      continue;
    }
    const cooldown = input.cooldownUntil?.[phase.id];
    if (cooldown !== undefined && !Number.isNaN(Date.parse(cooldown)) && (input.nowMs ?? Date.now()) < Date.parse(cooldown)) {
      continue; // a red gate's breather — the column cools down before it fires again
    }
    let capacity = phase.workers - (input.liveByColumn[phase.id] ?? 0);
    if (capacity <= 0) {
      continue;
    }
    const consider = (card: TicketCard): boolean => {
      if (capacity <= 0 || taken.has(card.id) || !dispatchable(card, input.busyTickets)) {
        return false;
      }
      taken.add(card.id);
      capacity -= 1;
      plan.push({ workingPhase: phase.id, fromPhase: card.phase, card });
      return true;
    };
    // The column's own queue first — refinement rounds included.
    for (const card of column.tickets) {
      consider(card);
    }
    // Top up from the previous column — never across an automatic one
    // (it feeds its successor itself) and never across a checkpoint.
    const previous = i > 0 ? input.columns[i - 1]! : null;
    if (previous !== null && !isAutoPhase(previous.phase) && !checkpoints.has(previous.phase.id)) {
      for (const card of previous.tickets) {
        consider(card);
      }
    }
  }
  return plan;
}
