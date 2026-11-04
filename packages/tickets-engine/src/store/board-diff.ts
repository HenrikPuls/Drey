import type { BoardSnapshot, TicketCard } from '../contracts/tickets';

/**
 * The shadow-mode comparison (E14-2): two board snapshots, built from two
 * stores by the same assembler, compared ticket by ticket and field by field.
 * Pure. The left side is what the UI shows (`files`), the right side is the
 * candidate (`dricket`).
 */

export interface FieldDiff {
  readonly field: string;
  readonly left: string;
  readonly right: string;
}

export interface TicketDiff {
  readonly id: string;
  readonly fields: readonly FieldDiff[];
}

export interface ColumnOrderDiff {
  readonly phase: string;
  readonly left: readonly string[];
  readonly right: readonly string[];
}

export interface BoardDiff {
  readonly leftCount: number;
  readonly rightCount: number;
  readonly identical: number;
  readonly onlyLeft: readonly string[];
  readonly onlyRight: readonly string[];
  readonly differing: readonly TicketDiff[];
  /** Columns whose ticket order differs among the tickets both sides share. */
  readonly columnOrder: readonly ColumnOrderDiff[];
  /** Pipeline columns that exist on one side only. */
  readonly columnsOnlyLeft: readonly string[];
  readonly columnsOnlyRight: readonly string[];
  readonly equal: boolean;
}

/**
 * Card fields that cannot match by design and are left out: the path (a store
 * has no `tickets/<phase>/` file), the runner's `run` stamp and the ledger
 * usage (neither is ticket data in dricket), the branch (the reader forces the
 * rule `t/<id>`).
 */
const IGNORED_META = new Set(['run', 'branch']);

function cardFields(card: TicketCard): Map<string, string> {
  const out = new Map<string, string>();
  out.set('phase', card.phase);
  out.set('worker', card.worker);
  out.set('blocked', card.blocked.join(', '));
  out.set('blocks', card.blocks.join(', '));
  out.set('issues', card.issues.map((i) => `${i.level}: ${i.message}`).sort().join(' | '));
  for (const [key, value] of Object.entries(card.meta)) {
    if (!IGNORED_META.has(key)) {
      out.set(`meta.${key}`, stringOf(value));
    }
  }
  return out;
}

function stringOf(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stringOf).join(', ');
  }
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function cardsOf(board: BoardSnapshot): Map<string, TicketCard> {
  const out = new Map<string, TicketCard>();
  for (const column of board.columns) {
    for (const card of column.tickets) {
      if (!out.has(card.id)) {
        out.set(card.id, card);
      }
    }
  }
  return out;
}

export function diffBoards(left: BoardSnapshot, right: BoardSnapshot): BoardDiff {
  const a = cardsOf(left);
  const b = cardsOf(right);
  const onlyLeft = [...a.keys()].filter((id) => !b.has(id)).sort();
  const onlyRight = [...b.keys()].filter((id) => !a.has(id)).sort();
  const differing: TicketDiff[] = [];
  let identical = 0;
  for (const id of [...a.keys()].filter((k) => b.has(k)).sort()) {
    const fa = cardFields(a.get(id)!);
    const fb = cardFields(b.get(id)!);
    const fields: FieldDiff[] = [];
    for (const key of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
      const l = fa.get(key) ?? '';
      const r = fb.get(key) ?? '';
      if (l !== r) {
        fields.push({ field: key, left: l, right: r });
      }
    }
    if (fields.length === 0) {
      identical += 1;
    } else {
      differing.push({ id, fields });
    }
  }

  const shared = new Set([...a.keys()].filter((id) => b.has(id)));
  const columnOrder: ColumnOrderDiff[] = [];
  const leftColumns = new Map(left.columns.map((c) => [c.phase.id, c]));
  const rightColumns = new Map(right.columns.map((c) => [c.phase.id, c]));
  for (const [phase, column] of leftColumns) {
    const other = rightColumns.get(phase);
    if (other === undefined) {
      continue;
    }
    const l = column.tickets.map((t) => t.id).filter((id) => shared.has(id));
    const r = other.tickets.map((t) => t.id).filter((id) => shared.has(id));
    if (l.join(',') !== r.join(',')) {
      columnOrder.push({ phase, left: l, right: r });
    }
  }
  const columnsOnlyLeft = [...leftColumns.keys()].filter((p) => !rightColumns.has(p));
  const columnsOnlyRight = [...rightColumns.keys()].filter((p) => !leftColumns.has(p));

  const equal =
    onlyLeft.length === 0 &&
    onlyRight.length === 0 &&
    differing.length === 0 &&
    columnOrder.length === 0 &&
    columnsOnlyLeft.length === 0 &&
    columnsOnlyRight.length === 0;
  return {
    leftCount: a.size,
    rightCount: b.size,
    identical,
    onlyLeft,
    onlyRight,
    differing,
    columnOrder,
    columnsOnlyLeft,
    columnsOnlyRight,
    equal,
  };
}

export interface ShadowReportInfo {
  readonly generatedAt: string;
  readonly leftName: string;
  readonly rightName: string;
  /** Set when the candidate store could not be read at all. */
  readonly error?: string;
}

/** A human-readable report (Markdown); the same data as JSON sits beside it. */
export function renderBoardDiff(diff: BoardDiff | null, info: ShadowReportInfo): string {
  const lines: string[] = [`# Board shadow report`, '', `Generated ${info.generatedAt}. Left = ${info.leftName} (what the UI shows), right = ${info.rightName}.`, ''];
  if (diff === null) {
    lines.push(`The ${info.rightName} board could not be built: ${info.error ?? 'unknown error'}`, '');
    return lines.join('\n');
  }
  lines.push(
    diff.equal
      ? `**Identical**: ${diff.leftCount} tickets on both sides, same columns, same order.`
      : `**Differs**: ${diff.leftCount} tickets left, ${diff.rightCount} right; ${diff.identical} identical, ${diff.differing.length} differ, ${diff.onlyLeft.length} only left, ${diff.onlyRight.length} only right.`,
    '',
  );
  if (diff.onlyLeft.length > 0) {
    lines.push(`## Only in ${info.leftName}`, '', diff.onlyLeft.join(', '), '');
  }
  if (diff.onlyRight.length > 0) {
    lines.push(`## Only in ${info.rightName}`, '', diff.onlyRight.join(', '), '');
  }
  if (diff.differing.length > 0) {
    lines.push('## Tickets that differ', '');
    for (const ticket of diff.differing) {
      lines.push(`### ${ticket.id}`, '');
      for (const f of ticket.fields) {
        lines.push(`- \`${f.field}\`: \`${f.left}\` -> \`${f.right}\``);
      }
      lines.push('');
    }
  }
  if (diff.columnOrder.length > 0) {
    lines.push('## Column order', '');
    for (const c of diff.columnOrder) {
      lines.push(`- ${c.phase}: ${c.left.join(' ')} -> ${c.right.join(' ')}`);
    }
    lines.push('');
  }
  if (diff.columnsOnlyLeft.length > 0 || diff.columnsOnlyRight.length > 0) {
    lines.push('## Columns', '', `Only left: ${diff.columnsOnlyLeft.join(', ') || '-'}; only right: ${diff.columnsOnlyRight.join(', ') || '-'}`, '');
  }
  return lines.join('\n');
}
