import type { TicketRecord, TicketStore } from '../ports/ticket-store';
import { DEFAULT_RANK } from '../contracts/tickets';
import { ticketNumber, type LegacyTicket } from './legacy-vault';
import { asStringList, flatten } from './convert';

/**
 * Shadow diff input (E14-3, migration-plan §5 step 3): the two boards reduced
 * to the same small shape -- one from the legacy vault, one from a
 * `TicketStore` listing -- and compared. E14-2's shadow mode feeds its own
 * rows in; the function neither reads files nor starts a process.
 *
 * Compared: the ticket set, stage, title, priority, the `depends` set and
 * the derived order of every column (`x-rank`, then number). Declared
 * differences are not differences: a legacy blocker that is outside the
 * store (dangling rule, R-12) and store tickets that are import placeholders.
 */

export interface BoardRow {
  /** Display id `T-0063`. */
  readonly id: string;
  readonly stage: string;
  readonly title: string;
  readonly priority: string;
  /** Display ids. */
  readonly dependsOn: readonly string[];
  readonly rank: number;
  /** A legacy rchive/ ticket / a store ticket with the rchived label (migrated with --include-archive). */
  readonly archived?: boolean;
}

/** `stageOf` maps a legacy phase to the stage the migration wrote (req-99a: `commit` -> `ready`); identity by default. */
export function rowsFromLegacy(tickets: readonly LegacyTicket[], stageOf: (phase: string) => string = (phase) => phase): BoardRow[] {
  return tickets.map((t) => ({
    id: t.id,
    stage: stageOf(t.phase),
    title: flatten(t.header['title']) ?? '',
    priority: flatten(t.header['priority']) ?? '',
    dependsOn: asStringList(t.header['blocked-by']),
    rank: rankOf(flatten(t.header['rank'])),
    archived: t.phase === 'archive',
  }));
}

/** Import placeholders (label `placeholder`) are not tickets of the board. */
export function rowsFromRecords(records: readonly TicketRecord[]): BoardRow[] {
  return records
    .filter((r) => !r.labels.includes('placeholder'))
    .map((r) => ({
      id: r.id,
      stage: r.stage,
      title: r.title,
      priority: r.priority ?? '',
      dependsOn: r.dependsOn,
      rank: rankOf(r.extensions['x-rank']),
      archived: r.labels.includes('archived'),
    }));
}

function rankOf(value: string | null | undefined): number {
  return value !== null && value !== undefined && /^-?\d+$/.test(value) ? Number(value) : DEFAULT_RANK;
}

export type DiffKind = 'only-in-legacy' | 'only-in-store' | 'stage' | 'title' | 'priority' | 'depends' | 'order';

export interface BoardDifference {
  readonly kind: DiffKind;
  readonly id: string | null;
  readonly legacy: string;
  readonly store: string;
}

export interface DeclaredDifference {
  readonly id: string;
  readonly what: string;
}

export interface ShadowDiff {
  readonly identical: boolean;
  readonly differences: readonly BoardDifference[];
  /** Differences the migration declares and therefore tolerates. */
  readonly declared: readonly DeclaredDifference[];
  readonly compared: number;
}

export function shadowDiff(legacy: readonly BoardRow[], store: readonly BoardRow[]): ShadowDiff {
  const differences: BoardDifference[] = [];
  const declared: DeclaredDifference[] = [];
  const storeById = new Map(store.map((r) => [r.id, r] as const));
  const legacyById = new Map(legacy.map((r) => [r.id, r] as const));

  for (const l of legacy) {
    const s = storeById.get(l.id);
    if (s === undefined) {
      differences.push({ kind: 'only-in-legacy', id: l.id, legacy: l.stage, store: '' });
      continue;
    }
    if (l.stage !== s.stage && !(l.archived === true && s.archived === true)) {
      differences.push({ kind: 'stage', id: l.id, legacy: l.stage, store: s.stage });
    }
    if (l.title !== s.title && isShortenedTitle(l.title, s.title)) {
      declared.push({ id: l.id, what: 'title longer than the dk limit, shortened (the full title leads the description)' });
    } else if (l.title !== s.title) {
      differences.push({ kind: 'title', id: l.id, legacy: l.title, store: s.title });
    }
    if (l.priority !== s.priority) {
      differences.push({ kind: 'priority', id: l.id, legacy: l.priority, store: s.priority });
    }
    const kept = l.dependsOn.filter((d) => storeById.has(d));
    for (const d of l.dependsOn.filter((x) => !storeById.has(x))) {
      declared.push({ id: l.id, what: `blocked-by ${d} is not in the store (dangling rule)` });
    }
    if (!sameSet(kept, s.dependsOn)) {
      differences.push({ kind: 'depends', id: l.id, legacy: [...kept].sort().join(', '), store: [...s.dependsOn].sort().join(', ') });
    }
  }
  for (const s of store) {
    if (!legacyById.has(s.id)) {
      differences.push({ kind: 'only-in-store', id: s.id, legacy: '', store: s.stage });
    }
  }

  // Derived order of each column, over the tickets both sides have.
  const common = legacy.filter((l) => storeById.has(l.id) && storeById.get(l.id)!.stage === l.stage);
  const stages = [...new Set(common.map((r) => r.stage))];
  for (const stage of stages) {
    const a = columnOrder(common.filter((r) => r.stage === stage));
    const b = columnOrder(common.filter((r) => r.stage === stage).map((r) => storeById.get(r.id)!));
    if (a.join(',') !== b.join(',')) {
      differences.push({ kind: 'order', id: null, legacy: `${stage}: ${a.join(' ')}`, store: `${stage}: ${b.join(' ')}` });
    }
  }
  return { identical: differences.length === 0, differences, declared, compared: legacy.length };
}

function isShortenedTitle(full: string, cut: string): boolean {
  return cut.endsWith('…') && cut.length < full.length && full.startsWith(cut.slice(0, -1));
}

function columnOrder(rows: readonly BoardRow[]): string[] {
  return [...rows].sort((a, b) => a.rank - b.rank || ticketNumber(a.id) - ticketNumber(b.id)).map((r) => r.id);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * The store side of the diff with full records. dk v0.6.0's `ls --json` has
 * only a header subset (no `depends`, no `x-` fields; R-05), so each ticket
 * is read with `show`. Placeholders are filtered from the list first and
 * never fetched.
 */
export async function collectStoreRows(store: Pick<TicketStore, 'list' | 'show'>): Promise<BoardRow[]> {
  const listed = (await store.list()).filter((r) => !r.labels.includes('placeholder'));
  const details: TicketRecord[] = [];
  for (const row of listed) {
    details.push(await store.show(row.id));
  }
  return rowsFromRecords(details);
}
