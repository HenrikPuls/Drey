/**
 * The remote's "Needs you" list (req-66, ADR-0086): everything that
 * waits on the owner, derived from one board snapshot and the fleet's
 * runs. Pure — the gateway calls it per request, nothing is stored.
 *
 * Order: questions, permissions, red gates, failed runs, then the
 * tickets sitting in a checkpoint column; oldest first within a kind.
 * The E8 report card is not derived here — it needs the ticket files'
 * `## Report` sections, so the port sweeps those (drey-port.ts) and packs
 * each item through `reportNeedOf` below. The E9 Bescheid card IS derived
 * here — a notify rule fires purely on the snapshot: the merged chain
 * (pipeline + the ticket's delta) plus the `entered-<phase>` stamps, no
 * file reads (`notifyNeedsOf` below).
 */
import { NOTIFY_WINDOW_MS } from '../contracts/chain';
import type { NeedItem, NeedKind } from '../contracts/remote-protocol';
import type { ScoutReport } from '../contracts/scout';
import { scoutNeedText } from '../contracts/scout';
import type { BoardSnapshot, TicketCard } from '../contracts/tickets';
import { mergeChain } from '../core/chain-delta';
import { READY_STATE } from '../core/pipeline-states';
import type { RunInfo, RunState } from '../fleet/protocol';

const LIVE: ReadonlySet<RunState> = new Set(['starting', 'running', 'stopping', 'detached']);
const KIND_ORDER: readonly NeedKind[] = ['question', 'permission', 'manual', 'red-gate', 'failed', 'checkpoint'];

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
          ...(waiting.shaped !== undefined ? { shaped: waiting.shaped } : {}),
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

  // E10-6: a ticket parked at a manual step waits for the owner, wherever it sits.
  for (const { card, phase } of placed.values()) {
    const awaiting = card.meta.awaiting;
    if (awaiting !== undefined && !hasLiveRun.has(card.id)) {
      items.push({
        kind: 'manual',
        ticketId: card.id,
        title: titleOf(card),
        phase,
        runId: null,
        text: `a manual step waits for ${awaiting}`,
        since: card.meta.entered[phase] ?? null,
      });
    }
  }

  const checkpoints = new Set(board.checkpoints);
  // With a Ready to try stage the sign-off is there: a ticket in the terminal column is finished.
  const lastColumn = board.columns.filter((column) => !column.unknown).at(-1);
  if (lastColumn !== undefined && board.columns.some((column) => column.phase.id === READY_STATE)) {
    checkpoints.delete(lastColumn.phase.id);
  }
  for (const { card, phase } of placed.values()) {
    if (checkpoints.has(phase) && !hasLiveRun.has(card.id) && card.meta.awaiting === undefined) {
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

/**
 * E8 (concept §5.6): the report card's pure shape — one scout ticket's
 * parsed `## Report` as a "Needs you" line, the report itself riding
 * along for the card's detail view. The caller sweeps the board for
 * `form: scout` tickets, reads each file and parses the section; this
 * builder only packs the item. A promoted ticket never reaches here —
 * the caller filters on the form, since the chapter stays in the file
 * as history after the flip to ship.
 */
export function reportNeedOf(card: TicketCard, phase: string, report: ScoutReport): NeedItem {
  return {
    kind: 'report',
    ticketId: card.id,
    title: titleOf(card),
    phase,
    runId: null,
    text: scoutNeedText(report),
    since: report.writtenAt === '' ? null : report.writtenAt,
    report,
  };
}

/**
 * E9 (concept §5.7): the Bescheid cards — one board sweep, every ticket's
 * chain delta merged over the pipeline, every notify rule on the merged
 * chain judged against the `entered-<phase>` stamps. A rule shows a card
 * from its gate's completion (the stamp of the following gate — entering
 * it IS the completion) until the ticket leaves the following gate or
 * `NOTIFY_WINDOW_MS` runs out, whichever comes first; a rule on the
 * chain's last gate has no observable completion and never fires. Pure —
 * the port appends the fold after its file-reading sweeps.
 */
export function notifyNeedsOf(board: BoardSnapshot, nowMs: number): readonly NeedItem[] {
  const phases = board.pipeline.map((phase) => ({ id: phase.id, title: phase.title }));
  const items: NeedItem[] = [];
  for (const column of board.columns) {
    for (const card of column.tickets) {
      const delta = card.meta.chain;
      if (delta === undefined || delta.length === 0) {
        continue;
      }
      const merged = mergeChain(phases, card.phase, delta);
      for (let at = 0; at < merged.length; at++) {
        const step = merged[at]!;
        if (!step.notify) {
          continue;
        }
        const following = merged[at + 1];
        if (following === undefined) {
          continue; // the chain's last gate completes outside the chain
        }
        const since = card.meta.entered[following.phase] ?? null;
        if (since === null) {
          continue; // the gate has not completed yet
        }
        const after = merged[at + 2];
        if (after !== undefined && card.meta.entered[after.phase] !== undefined) {
          continue; // the ticket left the following gate — the news is stale
        }
        const completedAt = Date.parse(since);
        if (Number.isFinite(completedAt) && completedAt + NOTIFY_WINDOW_MS <= nowMs) {
          continue; // the window ran out
        }
        items.push({
          kind: 'notify',
          ticketId: card.id,
          title: titleOf(card),
          phase: column.phase.id,
          runId: null,
          text: `the ${step.title} gate completed`,
          since,
        });
      }
    }
  }
  return items;
}

function titleOf(card: TicketCard): string {
  return card.meta.title ?? card.id;
}
