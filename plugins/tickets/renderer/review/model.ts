/**
 * The Review tab's state (E13-7), free of DOM and IPC: the changed files,
 * the owner's line comments and viewed marks (kept per ticket so a closed
 * tab or a restart loses nothing), and the words of the summary line and
 * footer. The comment shape is the engine's own `ReviewComment` -- the
 * Handover feedback of E11-3 -- never a second definition.
 */
import type { ReviewComment } from '../../../../packages/tickets-engine/src/core/review-feedback';
import { MAX_REVIEW_COMMENTS, MAX_REVIEW_COMMENT_CHARS } from '../../../../packages/tickets-engine/src/core/review-feedback';
import type { TicketDiff } from '../../../../packages/tickets-engine/src/core/worktree-changes';
import { countsOf, viewedKeyOf } from './patch';

export interface ReviewFile {
  readonly path: string;
  /** Git status letter (A / M / D / R). */
  readonly status: string;
  readonly patch: string;
  readonly added: number;
  readonly removed: number;
  /** Binary or otherwise patch-less: the tab names the file but has no lines to show. */
  readonly binary: boolean;
  /** The viewed mark's key (path + patch hash). */
  readonly key: string;
}

export function filesOf(diff: TicketDiff): ReviewFile[] {
  return diff.files.map((file) => {
    const { added, removed } = countsOf(file.patch);
    return {
      path: file.path,
      status: file.status,
      patch: file.patch,
      added,
      removed,
      binary: file.patch === '' || /^(Binary files |GIT binary patch)/m.test(file.patch),
      key: viewedKeyOf(file.path, file.patch),
    };
  });
}

/** `3 files · 1 of 3 viewed`. */
export function filesSummaryOf(files: readonly ReviewFile[], viewed: ReadonlySet<string>): string {
  const seen = files.filter((file) => viewed.has(file.key)).length;
  return `${files.length} ${files.length === 1 ? 'file' : 'files'} · ${seen} of ${files.length} viewed`;
}

/** `+84 −6`, `+61`, `−3`; '' for a binary file. */
export function statOf(file: Pick<ReviewFile, 'added' | 'removed'>): string {
  return [file.added > 0 ? `+${file.added}` : '', file.removed > 0 ? `−${file.removed}` : ''].filter((part) => part !== '').join(' ');
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// --- comments ---------------------------------------------------------------

export interface ReviewMarks {
  readonly comments: readonly ReviewComment[];
  readonly viewed: readonly string[];
}

export const EMPTY_MARKS: ReviewMarks = { comments: [], viewed: [] };

/** A comment's place: first line, last line (`endLine` when it is a range). */
export function commentEnd(comment: ReviewComment): number {
  return comment.endLine ?? comment.line;
}

/**
 * Adds `comment` (or replaces the one at `index`). Refused with null when
 * the text is empty or the list is full; the text is cut to the engine's
 * limit so the owner sees what will be sent.
 */
export function withComment(
  comments: readonly ReviewComment[],
  comment: ReviewComment,
  index: number | null = null,
): ReviewComment[] | null {
  const text = comment.text.replace(/\s+/g, ' ').trim().slice(0, MAX_REVIEW_COMMENT_CHARS);
  if (text === '') {
    return null;
  }
  const next: ReviewComment = { ...comment, text };
  if (index !== null && comments[index] !== undefined) {
    return comments.map((existing, at) => (at === index ? next : existing));
  }
  return comments.length >= MAX_REVIEW_COMMENTS ? null : [...comments, next];
}

export function withoutComment(comments: readonly ReviewComment[], index: number): ReviewComment[] {
  return comments.filter((_, at) => at !== index);
}

/** The range a click and a shift-click span; the lines come in either order. */
export function rangeOf(anchor: number, line: number): { line: number; endLine: number | null } {
  const first = Math.min(anchor, line);
  const last = Math.max(anchor, line);
  return { line: first, endLine: last > first ? last : null };
}

/** The comments of one file, in line order, with their place in the full list. */
export function commentsOfFile(
  comments: readonly ReviewComment[],
  file: string,
): { comment: ReviewComment; index: number }[] {
  return comments
    .map((comment, index) => ({ comment, index }))
    .filter((entry) => entry.comment.file === file)
    .sort((a, b) => a.comment.line - b.comment.line);
}

/** Marks whose file is no longer in the diff are dropped (the branch moved on). */
export function pruneMarks(marks: ReviewMarks, files: readonly ReviewFile[]): ReviewMarks {
  const paths = new Set(files.map((file) => file.path));
  const keys = new Set(files.map((file) => file.key));
  return {
    comments: marks.comments.filter((comment) => paths.has(comment.file)),
    viewed: marks.viewed.filter((key) => keys.has(key)),
  };
}

// --- persistence --------------------------------------------------------------

const STORAGE_PREFIX = 'drey.tickets.review.';

export interface MarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadMarks(storage: MarkStorage | null, ticketId: string): ReviewMarks {
  try {
    const raw = storage?.getItem(`${STORAGE_PREFIX}${ticketId}`) ?? null;
    if (raw === null) {
      return EMPTY_MARKS;
    }
    const parsed = JSON.parse(raw) as { comments?: unknown; viewed?: unknown };
    const comments = Array.isArray(parsed.comments)
      ? parsed.comments.filter(
          (item): item is ReviewComment =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as ReviewComment).file === 'string' &&
            typeof (item as ReviewComment).text === 'string' &&
            Number.isInteger((item as ReviewComment).line) &&
            ((item as ReviewComment).endLine === null || Number.isInteger((item as ReviewComment).endLine)),
        )
      : [];
    const viewed = Array.isArray(parsed.viewed) ? parsed.viewed.filter((item): item is string => typeof item === 'string') : [];
    return { comments, viewed };
  } catch {
    return EMPTY_MARKS;
  }
}

export function saveMarks(storage: MarkStorage | null, ticketId: string, marks: ReviewMarks): void {
  try {
    storage?.setItem(`${STORAGE_PREFIX}${ticketId}`, JSON.stringify(marks));
  } catch {
    // The marks then live for this tab only.
  }
}

// --- the footer ---------------------------------------------------------------

/** Left of the footer: how the checks stand; '' while the ticket has no Verification. */
export function checksLineOf(proof: { allPassed: boolean; checks: readonly { passed: boolean }[] } | null): string {
  if (proof === null || proof.checks.length === 0) {
    return '';
  }
  const passed = proof.checks.filter((check) => check.passed).length;
  return proof.allPassed ? `Checks green · ${passed}/${proof.checks.length}` : `Checks: ${passed}/${proof.checks.length} green`;
}
