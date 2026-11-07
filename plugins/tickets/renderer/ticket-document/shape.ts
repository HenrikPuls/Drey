/**
 * Shape in the editor (E13-9), the pure half: which open document can be
 * shaped with Paul, and the two marks the document shows under its Plan
 * chapter -- "Paul edited this · 2 min ago" and "You edited this · rides
 * along with your next message". No DOM, no IPC.
 *
 * The facts come from the engine's plan status (`PlanStatus`, E10-2): the
 * version and time of Paul's last turn, the owner's edit groups since, and
 * the marked lines. Nothing is recomputed here.
 */
import type { PlanMark } from '../../../../packages/tickets-engine/src/contracts/chat';
import type { BoardSnapshot } from '../../shared/tickets';
import { cardOfDocument, showsTicketDocument } from '../ticket-header';
import { ideaPhaseIds } from '../work-groups';

export interface ShapeTarget {
  readonly id: string;
  readonly path: string;
  /** The label of the attachment chip (`T-0130.md`). */
  readonly label: string;
}

/**
 * The ticket a vault file is, when it can be shaped: it sits in an Ideas
 * phase of the board's vault and no run works on it. Null for every other
 * file.
 */
export function shapeTargetOf(
  snapshot: BoardSnapshot | null,
  doc: { readonly path: string; readonly vaultId: string | null },
  runLive: (ticketId: string) => boolean,
): ShapeTarget | null {
  if (snapshot === null || (snapshot.vaultId !== null && doc.vaultId !== snapshot.vaultId && !showsTicketDocument(snapshot, doc.vaultId, doc.path))) {
    return null;
  }
  const card = cardOfDocument(snapshot, doc.path);
  if (card === null || !ideaPhaseIds(snapshot.pipeline).includes(card.phase) || runLive(card.id)) {
    return null;
  }
  // The open document's path: a dricket card's own is a stand-in no tab has (D-23).
  return { id: card.id, path: doc.path, label: `${card.id}.md` };
}

/** `just now`, `2 min ago`, `3 h ago`, `2 days ago`; an unreadable or future stamp reads as `just now`. */
export function agoWords(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return 'just now';
  }
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} days ago`;
}

/** The plan status the engine answers (`GET /api/tickets/<id>/plan`), as far as the marks need it. */
export interface PlanStatusLike {
  readonly ok: true;
  readonly version: number | null;
  readonly modelAt?: string | null;
  readonly edits: number;
  readonly summary: string | null;
  readonly marks: readonly PlanMark[];
}

export interface ShapeMarks {
  /** `Paul edited this · 2 min ago`; null when Paul changed nothing that still stands. */
  readonly paul: string | null;
  /** `You edited this · rides along with your next message`; null without edits since his last turn. */
  readonly you: string | null;
  /** The change summary behind `you` (`2 edits · +3 −1`), for the tooltip. */
  readonly youDetail: string | null;
  /** The marked lines of the plan: what the bars run down. */
  readonly lines: readonly PlanMark[];
}

/** True for a well-formed `ok` plan status; anything else (a refusal, junk) is not usable. */
export function isPlanStatus(value: unknown): value is PlanStatusLike {
  const v = value as Partial<PlanStatusLike> | null;
  return (
    v !== null &&
    typeof v === 'object' &&
    v.ok === true &&
    (v.version === null || typeof v.version === 'number') &&
    typeof v.edits === 'number' &&
    Array.isArray(v.marks)
  );
}

/** The two mark lines of a plan status; null when there is nothing to say. */
export function shapeMarksOf(status: PlanStatusLike | null, now: Date): ShapeMarks | null {
  if (status === null) {
    return null;
  }
  const modelEdited = status.version !== null && status.marks.some((mark) => mark.by === 'model');
  const paul = modelEdited
    ? typeof status.modelAt === 'string' && status.modelAt !== ''
      ? `Paul edited this · ${agoWords(status.modelAt, now)}`
      : 'Paul edited this'
    : null;
  const you = status.edits > 0 ? 'You edited this · rides along with your next message' : null;
  return paul === null && you === null ? null : { paul, you, youDetail: you === null ? null : status.summary, lines: status.marks };
}

/** The end offset of the `## Plan` heading line (outside code fences), or null without one. */
export function planHeadingEnd(text: string): number | null {
  let offset = 0;
  let fenced = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
    } else if (!fenced && /^##\s+Plan\s*$/.test(line)) {
      return offset + line.length;
    }
    offset += rawLine.length + 1;
  }
  return null;
}

/** One run of marked plan lines by the same hand. */
export interface MarkGroup {
  readonly by: PlanMark['by'];
  /** The start offsets of the lines. */
  readonly lines: readonly number[];
  /** The end offset of the last line: the note stands under it. */
  readonly end: number;
}

/**
 * Where the marks fall in the text (board 7b). A mark's `no` counts lines of the
 * Plan section as the engine read it; the buffer may have moved on, so a line
 * whose text no longer matches is looked up by its text, and dropped when it is gone.
 */
export function markGroupsOf(text: string, marks: Pick<ShapeMarks, 'lines'>): MarkGroup[] {
  const headingEnd = planHeadingEnd(text);
  if (headingEnd === null || marks.lines.length === 0) {
    return [];
  }
  const start = headingEnd + 1;
  const rest = text.slice(start);
  const next = /^#{1,2}\s/m.exec(rest);
  const lines = (next === null ? rest : rest.slice(0, next.index)).split('\n');
  const offsets: number[] = [];
  let at = start;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const clean = (line: string | undefined): string => (line ?? '').replace(/\r$/, '');
  const groups: { by: PlanMark['by']; numbers: number[] }[] = [];
  const found = marks.lines
    .map((mark) => {
      if (clean(lines[mark.no - 1]) === mark.text) {
        return { by: mark.by, no: mark.no - 1 };
      }
      const index = lines.findIndex((line) => clean(line) === mark.text);
      return index < 0 ? null : { by: mark.by, no: index };
    })
    .filter((mark): mark is { by: PlanMark['by']; no: number } => mark !== null && mark.no < lines.length && clean(lines[mark.no]).trim() !== '')
    .sort((a, b) => a.no - b.no);
  for (const mark of found) {
    const last = groups[groups.length - 1];
    // Only blank lines between them: one block, one note.
    const between = last === undefined ? [] : lines.slice(last.numbers[last.numbers.length - 1]! + 1, mark.no);
    if (last !== undefined && last.by === mark.by && between.every((line) => line.trim() === '')) {
      last.numbers.push(mark.no);
    } else {
      groups.push({ by: mark.by, numbers: [mark.no] });
    }
  }
  return groups.map((group) => {
    const lastNo = group.numbers[group.numbers.length - 1]!;
    return {
      by: group.by,
      lines: group.numbers.map((no) => offsets[no]!),
      end: offsets[lastNo]! + clean(lines[lastNo]).length,
    };
  });
}
