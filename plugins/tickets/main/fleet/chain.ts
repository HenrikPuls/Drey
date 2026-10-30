/**
 * The chain's pure planning core (M85, ADR-0077): which columns run
 * themselves, where the owner's checkpoints sit, and what the
 * orchestrator dispatches next. No IO — the runner and the specs feed
 * it assembled board columns and the persisted control state.
 *
 * The rules, in the owner's words:
 * - A column with a worker (handover `agent …`) drains itself; a column
 *   without one is a manual step — the human moves its tickets.
 * - The parallel slots belong to the provider pools, not to columns
 *   (req-63): an idle slot serves whichever column has the most
 *   important ticket — high priority first, then the rightmost column.
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
  type TicketPriority,
} from '../../shared/tickets';
import { WORKER_PROVIDERS, type ChainMaster, type ColumnMode, type WorkerProviderId } from './protocol';

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
  /** The parallel runs each provider's pool carries (req-63). */
  readonly poolSize: Readonly<Record<WorkerProviderId, number>>;
  /** Live (starting/running/stopping) runs per provider — every run, the
   *  owner's on-demand ones included, takes a pool slot. */
  readonly liveByPool: Readonly<Record<WorkerProviderId, number>>;
  /** The provider that would run the card in that column (the assignment
   *  ladder); null = unresolvable — planned without a slot, so the
   *  dispatch refuses it with the reason. */
  readonly poolOf: (card: TicketCard, phase: PipelinePhase) => WorkerProviderId | null;
  /** Ticket ids that must not be dispatched (a live or detached run
   *  somewhere, or a run stamp without a supervised run). */
  readonly busyTickets: ReadonlySet<string>;
  /** Columns in cooldown until this ISO instant (a red gate's breather). */
  readonly cooldownUntil?: Readonly<Record<string, string>>;
  /** Now, for the cooldown comparison (epoch ms). */
  readonly nowMs?: number;
}

export interface PlannedDispatch {
  /** The column that works the ticket (= the RunRequest's `column`). */
  readonly workingPhase: string;
  /** Where the ticket file sits now (a pull leaves it there until the move). */
  readonly fromPhase: string;
  readonly card: TicketCard;
  /** The provider pool the run takes a slot of; null = unresolvable. */
  readonly pool: WorkerProviderId | null;
}

/** A card the machine may take: unclaimed, unblemished, not already
 *  running, not blocked (T-0050 — a blocked ticket never enters a
 *  worker pool until its blockers reach the terminal phase). */
export function dispatchable(card: TicketCard, busyTickets: ReadonlySet<string>): boolean {
  if (busyTickets.has(card.id) || card.meta.run !== null || card.meta.claimedBy !== null) {
    return false;
  }
  if (card.blocked.length > 0) {
    return false;
  }
  return !card.issues.some((issue) => issue.level === 'error');
}

/**
 * The dispatch class of a priority (req-63): `urgent` and `high` jump
 * every column's `normal` / `low` tickets; inside a class the column
 * rank decides.
 */
export function priorityClass(priority: TicketPriority): 0 | 1 {
  return priority === 'urgent' || priority === 'high' ? 0 : 1;
}

/**
 * What to dispatch right now, in dispatch order (req-63). The slots
 * belong to the provider pools, not to the columns: one candidate list
 * across every automatic, playing column with a move target, ordered by
 * priority class (urgent/high first), then column rank — the rightmost
 * column first, finishing work beats starting it — then column order.
 * Each candidate takes a slot of its provider's pool while one is free;
 * a running run is never preempted. The machine never pulls from a
 * manual column: `prioritized` is the owner's queue, and he moves
 * tickets into worker columns himself (owner ruling, 2026-10-18).
 */
export function planDispatch(input: PlanDispatchInput): readonly PlannedDispatch[] {
  if (input.master !== 'run') {
    return [];
  }
  interface Candidate {
    readonly card: TicketCard;
    readonly phase: PipelinePhase;
    readonly columnIndex: number;
    readonly position: number;
  }
  const candidates: Candidate[] = [];
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
    column.tickets.forEach((card, position) => {
      if (dispatchable(card, input.busyTickets)) {
        candidates.push({ card, phase, columnIndex: i, position });
      }
    });
  }
  candidates.sort(
    (a, b) =>
      priorityClass(a.card.meta.priority) - priorityClass(b.card.meta.priority) ||
      b.columnIndex - a.columnIndex ||
      a.position - b.position,
  );

  const free: Record<WorkerProviderId, number> = { opencode: 0, 'claude-code': 0 };
  for (const provider of WORKER_PROVIDERS) {
    free[provider] = (input.poolSize[provider] ?? 0) - (input.liveByPool[provider] ?? 0);
  }
  const plan: PlannedDispatch[] = [];
  const taken = new Set<string>();
  for (const candidate of candidates) {
    if (taken.has(candidate.card.id)) {
      continue;
    }
    const pool = input.poolOf(candidate.card, candidate.phase);
    if (pool !== null) {
      if (free[pool] <= 0) {
        continue;
      }
      free[pool] -= 1;
    }
    taken.add(candidate.card.id);
    plan.push({ workingPhase: candidate.phase.id, fromPhase: candidate.card.phase, card: candidate.card, pool });
  }
  return plan;
}
