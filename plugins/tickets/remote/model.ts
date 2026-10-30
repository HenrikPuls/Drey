/**
 * The phone client's view logic (req-66, ADR-0084), pure so it is
 * tested without a DOM: where a ticket sits, what its one primary
 * action is, the ticket file as display blocks, and the swipe rule.
 */
import type { RunInfo } from '../main/fleet/protocol';
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
  | { readonly kind: 'code'; readonly text: string };

/** Paragraphs, list items (with checkbox state) and fenced code — enough for a ticket. */
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
  for (const raw of lines) {
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
