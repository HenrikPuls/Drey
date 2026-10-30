/**
 * The remote's "Needs you" list (req-66, ADR-0084): everything that
 * waits on the owner, derived from one board snapshot and the fleet's
 * runs. Pure — the gateway calls it per request, nothing is stored.
 *
 * Order: questions, permissions, red gates, failed runs, then the
 * tickets sitting in a checkpoint column; oldest first within a kind.
 */
import type { NeedItem, NeedKind } from '../../shared/remote-protocol';
import type { BoardSnapshot, TicketCard } from '../../shared/tickets';
import type { RunInfo, RunState } from '../fleet/protocol';

const LIVE: ReadonlySet<RunState> = new Set(['starting', 'running', 'stopping', 'detached']);
const KIND_ORDER: readonly NeedKind[] = ['question', 'permission', 'red-gate', 'failed', 'checkpoint'];

interface Placed {
  readonly card: TicketCard;
  readonly phase: string;
}

export function needsOf(board: BoardSnapshot, runs: readonly RunInfo[]): readonly NeedItem[] {
  const placed = new Map<string, Placed>();
  for (const column of board.columns) {
    for (const card of column.tickets) {
      placed.set(card.id, { card, phase: column.phase.id });
    }
  }

  const latest = new Map<string, RunInfo>();
  for (const run of runs) {
    const seen = latest.get(run.ticketId);
    if (seen === undefined || run.startedAt > seen.startedAt) {
      latest.set(run.ticketId, run);
    }
  }

  const items: NeedItem[] = [];
  const hasLiveRun = new Set<string>();
  for (const run of latest.values()) {
    const at = placed.get(run.ticketId);
    if (at === undefined) {
      continue;
    }
    const base = { ticketId: run.ticketId, title: titleOf(at.card), phase: at.phase, runId: run.id };
    if (LIVE.has(run.state)) {
      hasLiveRun.add(run.ticketId);
      const waiting = run.waiting ?? null;
      if (waiting !== null) {
        items.push({
          ...base,
          kind: waiting.kind,
          text: waiting.text,
          since: waiting.since,
          ...(waiting.questions !== undefined ? { questions: waiting.questions } : {}),
        });
      }
      continue;
    }
    // A settled run only needs the owner while its ticket still sits in
    // the phase it ran in — a moved ticket has been dealt with.
    if (run.phase !== undefined && run.phase !== null && run.phase !== at.phase) {
      continue;
    }
    if (run.gateResult === 'red' || run.gateFailure !== null) {
      items.push({ ...base, kind: 'red-gate', text: run.gateFailure ?? 'the gate is red', since: run.endedAt });
    } else if (run.state === 'failed') {
      items.push({ ...base, kind: 'failed', text: run.lastError ?? 'the run failed', since: run.endedAt });
    }
  }

  const checkpoints = new Set(board.checkpoints);
  for (const { card, phase } of placed.values()) {
    if (checkpoints.has(phase) && !hasLiveRun.has(card.id)) {
      items.push({
        kind: 'checkpoint',
        ticketId: card.id,
        title: titleOf(card),
        phase,
        runId: null,
        text: '',
        since: card.meta.entered[phase] ?? null,
      });
    }
  }

  return items.sort((a, b) => {
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (byKind !== 0) {
      return byKind;
    }
    return (a.since ?? '￿').localeCompare(b.since ?? '￿');
  });
}

function titleOf(card: TicketCard): string {
  return card.meta.title ?? card.id;
}
