/**
 * The Board tab's pure model (E13-8): the pipeline as columns, each ticket
 * a card with its persona, kind and cost, the parts of a ticket under it,
 * and the cost of every column. Pure, so the tab and the spec share it.
 *
 * - **Persona of a card**: the live run's persona, else the ticket's pin
 *   (`persona:`), else the column's persona (pipeline.md) - the ladder the
 *   fleet reads, shown as the owner would expect.
 * - **Cost**: the ticket's settled-run usage (`TicketCard.usage.cost`, the
 *   ledger's sum); a ticket without a known cost shows none, never `$0.00`.
 *   A column's cost sums the known costs of its cards and their parts.
 * - **Parts**: a ticket with `parent:` hangs under that parent when the
 *   parent is on the board; the plan's parts that are no tickets yet
 *   (`planParts`) hang under the planning ticket, marked as plan parts.
 * - No estimate here: an estimate needs >= 3 similar runs (decision D9)
 *   and is the ticket header's (E13-6).
 */
import type { PlanPartCard } from '../../../../packages/tickets-engine/src/contracts/plan-approval';
import type { RunInfo } from '../../../../packages/tickets-engine/src/fleet/protocol';
import type { BoardSnapshot, TicketCard } from '../../shared/tickets';
import { isLiveRun, usd } from '../team/team-model';
import { needKindLabel, workGroups } from '../work-groups';

/** A part of a ticket: another ticket (`parent:`) or a plan part not released yet. */
export interface BoardPartModel {
  /** The part's ticket id; null = still only in the plan. */
  readonly ticketId: string | null;
  /** `T-0130 · P2`-style handle: the ticket id, or `P<n>` for a plan part. */
  readonly handle: string;
  readonly title: string;
  readonly personaId: string | null;
  /** `after P1`, `queued`, `running`, `done`, ... */
  readonly state: string;
  readonly cost: number | null;
  /** The card behind the part, to open it; null for a plan part. */
  readonly card: TicketCard | null;
}

export interface BoardCardModel {
  readonly card: TicketCard;
  readonly id: string;
  readonly title: string;
  /** What waits on the owner, beside the id (`Question`, `Plan to accept`, `Accept`); '' = nothing waits (board 7e). */
  readonly kind: string;
  readonly personaId: string | null;
  readonly cost: number | null;
  /** The card's second line (`queued, waits for a slot`, the worker's activity, ...); '' = none. */
  readonly line: string;
  readonly running: boolean;
  readonly parts: readonly BoardPartModel[];
}

export interface BoardColumnModel {
  readonly id: string;
  readonly title: string;
  readonly cards: readonly BoardCardModel[];
  /** The summed known cost of the column (cards and their parts); null = none known. */
  readonly cost: number | null;
  /** True for the first column, where "New idea" lands. */
  readonly first: boolean;
  /** True for the last column: its tickets are done (the board's own Done column shows the archive). */
  readonly terminal: boolean;
}

export interface BoardModel {
  readonly columns: readonly BoardColumnModel[];
  /** Done this week: the archive's last seven days, the last column. */
  readonly done: readonly { readonly id: string; readonly title: string }[];
  readonly total: number;
}

function costOf(card: TicketCard): number | null {
  const cost = card.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null;
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

const liveRunOf = (id: string, runs: readonly RunInfo[]): RunInfo | null =>
  runs.find((run) => run.ticketId === id && isLiveRun(run)) ?? null;

const PART_STATE_WORD: Readonly<Record<string, string>> = {
  new: 'not released',
  queued: 'queued',
  running: 'running',
  active: 'in progress',
  done: 'done',
};

/** Plan parts that are no tickets yet, by planning ticket id. */
export type PlanPartsById = ReadonlyMap<string, readonly PlanPartCard[]>;

export function boardModelOf(
  snap: BoardSnapshot,
  runs: readonly RunInfo[],
  planParts: PlanPartsById = new Map(),
): BoardModel {
  const configured = snap.columns.filter((column) => !column.unknown);
  const byId = new Map<string, TicketCard>();
  for (const column of snap.columns) {
    for (const card of column.tickets) {
      byId.set(card.id, card);
    }
  }
  // Children by parent: a part hangs under its ticket when that ticket is on the board.
  const childrenOf = new Map<string, TicketCard[]>();
  const nested = new Set<string>();
  for (const card of byId.values()) {
    const parent = card.meta.parent;
    if (typeof parent === 'string' && parent !== card.id && byId.has(parent)) {
      nested.add(card.id);
      const list = childrenOf.get(parent) ?? [];
      list.push(card);
      childrenOf.set(parent, list);
    }
  }
  // What waits on the owner is the one thing a card says about itself (board 7e);
  // the Work panel's own reading of a need, so the two surfaces agree.
  const needWord = new Map<string, string>();
  for (const row of workGroups(snap, runs).needs) {
    if (row.need !== null) {
      const label = needKindLabel(row.need, snap);
      needWord.set(row.card.id, label === 'Ready to try' ? 'Accept' : label);
    }
  }
  const terminal = configured.length > 0 ? configured[configured.length - 1]!.phase.id : null;
  const columnPersonaOf = new Map<string, string | null>();
  for (const column of snap.columns) {
    for (const card of column.tickets) {
      columnPersonaOf.set(card.id, column.phase.persona);
    }
  }
  const personaOf = (card: TicketCard): string | null => {
    const run = liveRunOf(card.id, runs);
    return (run?.persona ?? null) || card.meta.persona || (columnPersonaOf.get(card.id) ?? null);
  };
  const partOf = (child: TicketCard): BoardPartModel => {
    const run = liveRunOf(child.id, runs);
    return {
      ticketId: child.id,
      handle: child.id,
      title: child.meta.title ?? '(untitled)',
      personaId: personaOf(child),
      state: run !== null ? 'running' : child.phase === terminal ? 'done' : child.phase,
      cost: costOf(child),
      card: child,
    };
  };
  const columns: BoardColumnModel[] = configured.map((column, index) => {
    const cards: BoardCardModel[] = column.tickets
      .filter((card) => !nested.has(card.id))
      .map((card) => {
        const run = liveRunOf(card.id, runs);
        const children = (childrenOf.get(card.id) ?? []).map((child) => partOf(child));
        const planned: BoardPartModel[] = (planParts.get(card.id) ?? [])
          .filter((part) => part.ticket === null)
          .map((part) => ({
            ticketId: null,
            handle: `P${part.index + 1}`,
            title: part.title,
            personaId: part.persona,
            state: part.start !== '' ? part.start : PART_STATE_WORD[part.state] ?? part.state,
            cost: null,
            card: null,
          }));
        const parts = [...children, ...planned];
        return {
          card,
          id: card.id,
          title: card.meta.title ?? '(untitled)',
          kind: needWord.get(card.id) ?? '',
          personaId: personaOf(card),
          cost: costOf(card),
          line: run?.activity ?? (card.blocked.length > 0 ? `blocked by ${card.blocked.join(', ')}` : ''),
          running: run !== null,
          parts,
        };
      });
    const cost = sumKnown(cards.flatMap((entry) => [entry.cost, ...entry.parts.map((part) => part.cost)]));
    return { id: column.phase.id, title: column.phase.title, cards, cost, first: index === 0, terminal: index === configured.length - 1 };
  });
  return {
    columns,
    done: snap.recentDone.map((entry) => ({ id: entry.id, title: entry.title ?? '' })),
    total: byId.size,
  };
}

/** The column's cost as the head writes it; '' = none known. */
export function columnCostText(column: BoardColumnModel): string {
  return column.cost === null ? '' : usd(column.cost);
}

/** The plan-bearing tickets worth asking `planParts` for: cards in an owner-checkpoint column. */
export function planCandidatesOf(snap: BoardSnapshot): readonly string[] {
  const out: string[] = [];
  for (const column of snap.columns) {
    if (snap.checkpoints.includes(column.phase.id)) {
      for (const card of column.tickets) {
        out.push(card.id);
      }
    }
  }
  return out;
}
