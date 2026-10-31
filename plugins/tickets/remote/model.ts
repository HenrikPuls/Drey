/**
 * The phone client's view logic (req-66, ADR-0086), pure so it is
 * tested without a DOM: where a ticket sits, what its one primary
 * action is, the ticket file as display blocks, and the swipe rule.
 */
import type { RunInfo } from '../main/fleet/protocol';
import { splitRow } from '../shared/markdown';
import { parseHandover, type BoardColumn, type BoardSnapshot, type TicketCard } from '../shared/tickets';

const LIVE: ReadonlySet<string> = new Set(['starting', 'running', 'stopping', 'detached']);

export interface Placement {
  readonly column: BoardColumn;
  readonly card: TicketCard;
  readonly index: number;
}

export function placeOf(board: BoardSnapshot, id: string): Placement | null {
  for (const column of board.columns) {
    const index = column.tickets.findIndex((t) => t.id === id);
    if (index >= 0) {
      return { column, card: column.tickets[index]!, index };
    }
  }
  return null;
}

/** The pipeline column after `phaseId`; null on the last one or an unknown phase. */
export function nextColumnOf(board: BoardSnapshot, phaseId: string): BoardColumn | null {
  const columns = board.columns.filter((c) => !c.unknown);
  const index = columns.findIndex((c) => c.phase.id === phaseId);
  return index < 0 || index + 1 >= columns.length ? null : columns[index + 1]!;
}

export function liveRunOf(ticketId: string, runs: readonly RunInfo[]): RunInfo | null {
  let found: RunInfo | null = null;
  for (const run of runs) {
    if (run.ticketId === ticketId && LIVE.has(run.state) && (found === null || run.startedAt > found.startedAt)) {
      found = run;
    }
  }
  return found;
}

export function latestRunOf(ticketId: string, runs: readonly RunInfo[]): RunInfo | null {
  let found: RunInfo | null = null;
  for (const run of runs) {
    if (run.ticketId === ticketId && (found === null || run.startedAt > found.startedAt)) {
      found = run;
    }
  }
  return found;
}

export function isBusy(card: TicketCard, runs: readonly RunInfo[]): boolean {
  return card.meta.run !== null || liveRunOf(card.id, runs) !== null;
}

export type PrimaryAction =
  | { readonly kind: 'approve' | 'move'; readonly to: string; readonly label: string }
  | { readonly kind: 'run'; readonly label: string }
  | { readonly kind: 'busy'; readonly label: string };

/**
 * The ticket's one big button: a live run is busy; a checkpoint column
 * approves into the next phase; an agent column runs its agent;
 * otherwise the ticket moves on; the last column has none.
 */
export function primaryActionOf(
  board: BoardSnapshot,
  phaseId: string,
  card: TicketCard,
  runs: readonly RunInfo[],
): PrimaryAction | null {
  if (isBusy(card, runs)) {
    return { kind: 'busy', label: 'Run in progress' };
  }
  const column = board.columns.find((c) => c.phase.id === phaseId) ?? null;
  const next = nextColumnOf(board, phaseId);
  if (next !== null && board.checkpoints.includes(phaseId)) {
    return { kind: 'approve', to: next.phase.id, label: `Approve → ${next.phase.title}` };
  }
  if (column !== null && parseHandover(column.phase.handover).mode === 'agent') {
    return { kind: 'run', label: 'Run agent' };
  }
  if (next !== null) {
    return { kind: 'move', to: next.phase.id, label: `Move to ${next.phase.title}` };
  }
  return null;
}

/** Take over a claim someone else holds (or nobody); release your own. */
export function claimActionOf(card: TicketCard, actor: string): 'takeover' | 'release' {
  return card.meta.claimedBy === actor ? 'release' : 'takeover';
}

export function commitLineOf(id: string, from: string, to: string): string {
  return `tickets: ${id} ${from} -> ${to}`;
}

// --- the ticket file as display blocks -------------------------------------

export interface Section {
  readonly title: string;
  readonly level: number;
  readonly lines: readonly string[];
}

/** The body after the frontmatter, split at `##`/`###` headings. */
export function sectionsOf(text: string): Section[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const body = normalized.startsWith('---\n')
    ? normalized.slice(Math.max(normalized.indexOf('\n---', 4), 0)).replace(/^\n---[^\n]*\n?/, '')
    : normalized;
  const sections: Section[] = [];
  let current: { title: string; level: number; lines: string[] } = { title: '', level: 0, lines: [] };
  for (const line of body.split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      if (current.title !== '' || current.lines.some((l) => l.trim() !== '')) {
        sections.push(current);
      }
      current = { title: heading[2]!.trim(), level: heading[1]!.length, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.title !== '' || current.lines.some((l) => l.trim() !== '')) {
    sections.push(current);
  }
  return sections;
}

export type Block =
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'li'; readonly text: string; readonly checked: boolean | null }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'table'; readonly rows: readonly string[][] }
  | { readonly kind: 'hr' }
  | { readonly kind: 'h'; readonly level: number; readonly text: string };

/** Tables and rules, shaped like the desk's transcript renderer. */
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+(?:\s*:?-{2,}:?\s*)?\|?\s*$/;

/**
 * Paragraphs, list items (with checkbox state), fenced code, pipe tables,
 * rules and in-section headings — enough for a ticket and a worker reply.
 */
export function blocksOf(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'p', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!;
    if (code !== null) {
      if (/^\s*```/.test(raw)) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (/^\s*```/.test(raw)) {
      flush();
      code = [];
      continue;
    }
    const heading = /^\s*(#{1,6})[ \t]+(.*?)[ \t#]*$/.exec(raw);
    if (heading !== null) {
      flush();
      blocks.push({ kind: 'h', level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      flush();
      blocks.push({ kind: 'hr' });
      continue;
    }
    if (TABLE_ROW.test(raw) && n + 1 < lines.length && TABLE_RULE.test(lines[n + 1]!)) {
      const rows: string[][] = [splitRow(raw)];
      n += 2;
      while (n < lines.length && TABLE_ROW.test(lines[n]!)) {
        rows.push(splitRow(lines[n]!));
        n += 1;
      }
      n -= 1;
      flush();
      blocks.push({ kind: 'table', rows });
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(raw);
    if (item !== null) {
      flush();
      blocks.push({ kind: 'li', text: item[2]!, checked: item[1] === undefined ? null : item[1] !== ' ' });
    } else if (raw.trim() === '') {
      flush();
    } else {
      paragraph.push(raw.trim());
    }
  }
  flush();
  if (code !== null) {
    blocks.push({ kind: 'code', text: code.join('\n') });
  }
  return blocks;
}

// --- gestures ---------------------------------------------------------------

/** A left swipe moves the card on: far enough, and clearly sideways rather than a scroll. */
export function swipeCommits(dx: number, dy: number, width: number): boolean {
  return dx < -Math.max(80, width * 0.3) && Math.abs(dx) > Math.abs(dy) * 1.5;
}

// --- runs -------------------------------------------------------------------

export function isLive(run: RunInfo): boolean {
  return LIVE.has(run.state);
}

/** Live runs newest first, then the most recent settled ones. */
export function runsForList(runs: readonly RunInfo[], recent = 10): { live: RunInfo[]; recent: RunInfo[] } {
  const byStart = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const seen = new Set<string>();
  const unique = byStart.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return { live: unique.filter(isLive), recent: unique.filter((r) => !isLive(r)).slice(0, recent) };
}

/** One word for a run's state as the phone shows it. */
export function runStateLabel(run: RunInfo): string {
  if (run.waiting) {
    return run.waiting.kind === 'permission' ? 'needs permission' : 'asks you';
  }
  if (run.state === 'running' && run.held === true) {
    return 'held';
  }
  if (run.state === 'running' && run.turn === 'idle') {
    return 'standing';
  }
  if (!isLive(run) && (run.gateResult === 'red' || run.gateFailure !== null)) {
    return 'gate red';
  }
  return run.state;
}

/** Compact token count: 812, 48k, 1.2M. */
export function tokensLabel(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return '';
  }
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${Math.round(n / 1000)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// --- answering a waiting worker --------------------------------------------

export interface FormQuestion {
  readonly key: string;
  readonly multiple: boolean;
}

/**
 * The `answers` body for OpenCode's question form: per field the own
 * words when given, else the picked choice(s). Null while a field has
 * neither — the form is not complete yet.
 */
export function answersOf(
  questions: readonly FormQuestion[],
  picked: ReadonlyMap<string, readonly string[]>,
  typed: ReadonlyMap<string, string>,
): Record<string, string | string[]> | null {
  const out: Record<string, string | string[]> = {};
  for (const q of questions) {
    const own = (typed.get(q.key) ?? '').trim();
    const choice = picked.get(q.key) ?? [];
    if (own !== '') {
      out[q.key] = own;
    } else if (choice.length > 0) {
      out[q.key] = q.multiple ? [...choice] : choice[0]!;
    } else {
      return null;
    }
  }
  return out;
}

// --- refining ---------------------------------------------------------------

export type RefineKey = 'description' | 'plan' | 'acceptance';

export const REFINE_TITLES: Readonly<Record<RefineKey, string>> = {
  description: 'Description',
  plan: 'Plan',
  acceptance: 'Acceptance criteria',
};

export function refineKeyOf(title: string): RefineKey | null {
  const key = (Object.keys(REFINE_TITLES) as RefineKey[]).find((k) => REFINE_TITLES[k].toLowerCase() === title.toLowerCase());
  return key ?? null;
}

/** One section's text as it stands in the file, trimmed — what the editor starts from. */
export function sectionTextOf(text: string, key: RefineKey): string {
  const section = sectionsOf(text).find((s) => s.title.toLowerCase() === REFINE_TITLES[key].toLowerCase());
  return section === undefined ? '' : section.lines.join('\n').trim();
}

// --- kanban drag (iPad) -----------------------------------------------------

/** Where a dragged card lands: how many of the column's other cards sit above the pointer. */
export function dropIndexOf(otherMidpoints: readonly number[], y: number): number {
  return otherMidpoints.filter((mid) => mid < y).length;
}

export interface DropAction {
  readonly from: string;
  readonly to: string;
}

/**
 * The desk call a drop makes: a move across columns. A drop inside the
 * card's own column does nothing — the column order is derived, there
 * are no pins (req-74).
 */
export function dropActionOf(from: string, to: string): DropAction | null {
  return from === to ? null : { from, to };
}
