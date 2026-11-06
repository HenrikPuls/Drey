/**
 * The status verbs as dricket comments (E14-6, ADR-0090): on a store the
 * persona's verbs of `status-log.ts` are not a `<ticket>.status.log` file any
 * more but the first line of a comment (`dk comment`), keyed exactly as before:
 *
 *     needs-decision: [palette-shortcut] Which shortcut should open the palette?
 *     resolved: palette-shortcut
 *
 *     The owner answered: Ctrl+K.
 *
 * Line one is the machine line (the verb grammar of the status log, one parser
 * for both), everything after a blank line is free detail. `working:` is the
 * heartbeat of a live run and is **never persisted** — {@link renderStatusComment}
 * answers null for it. The comment's own timestamp is the line's `at`.
 */
import { parseStatusLog, type StatusLine, type StatusVerb } from './status-log';

export interface StatusCommentInput {
  readonly verb: StatusVerb;
  /** The decision key (`needs-decision`, `blocked`) or the key being closed (`resolved`). */
  readonly key?: string | null;
  /** The one-line payload; line breaks are folded to spaces. */
  readonly text?: string;
  /** Free text below the machine line (an answer, a worker's report). */
  readonly detail?: string;
}

const KEY = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** A key that fits the grammar, or null (the line is then written keyless and stays visible). */
export function normalizeStatusKey(key: string | null | undefined): string | null {
  const trimmed = (key ?? '').trim().toLowerCase();
  return KEY.test(trimmed) ? trimmed : null;
}

/** A free text as a key: lower-case words joined by dashes, at most 64 characters; null when nothing is left. */
export function slugStatusKey(text: string): string | null {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return normalizeStatusKey(slug);
}

/** The comment text for one status event; null for `working` (not persisted). */
export function renderStatusComment(input: StatusCommentInput): string | null {
  if (input.verb === 'working') {
    return null;
  }
  const key = normalizeStatusKey(input.key);
  const text = (input.text ?? '').replace(/\s+/g, ' ').trim();
  let line: string;
  if (input.verb === 'resolved') {
    if (key === null) {
      return null; // a keyless `resolved:` closes nothing
    }
    line = `resolved: ${key}`;
  } else if (input.verb === 'needs-decision' || input.verb === 'blocked') {
    line = `${input.verb}:${key === null ? '' : ` [${key}]`}${text === '' ? '' : ` ${text}`}`;
  } else {
    line = `${input.verb}:${text === '' ? '' : ` ${text}`}`;
  }
  const detail = (input.detail ?? '').trim();
  return detail === '' ? line : `${line}\n\n${detail}`;
}

const DECISION_NEEDED = /^decision needed:\s*(.*)$/i;

/** The status line a comment carries, or null when its first line is no verb line (an ordinary comment). */
export function parseStatusComment(at: string, text: string): StatusLine | null {
  const first = (text.split('\n')[0] ?? '').trim();
  if (first === '' || /['\n]/.test(at)) {
    return null;
  }
  // The form a person writes in a terminal (D-12): the same open decision, keyed by its words.
  const asked = DECISION_NEEDED.exec(first)?.[1]?.trim();
  if (asked !== undefined && asked !== '') {
    return { at, verb: 'needs-decision', key: slugStatusKey(asked), text: asked };
  }
  const [line] = parseStatusLog(`- '${at}' ${first}`);
  return line ?? null;
}

/**
 * The status lines of a ticket's comments, oldest first. dk names a comment file
 * `<second>-<author>.md`, so the store knows no order inside one second — two
 * comments of one second come in author-name order. A `resolved` that shares its
 * second with the decision it closes must not be folded first (the decision would
 * then stay open), so within one timestamp the lines that open something go
 * before the ones that close it; otherwise the order the comments came in stands.
 */
export function statusLinesOfComments(comments: readonly { readonly at: string; readonly text: string }[]): readonly StatusLine[] {
  const lines: StatusLine[] = [];
  for (const comment of comments) {
    const line = parseStatusComment(comment.at, comment.text);
    if (line !== null) {
      lines.push(line);
    }
  }
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => (a.line.at < b.line.at ? -1 : a.line.at > b.line.at ? 1 : 0) || closes(a.line) - closes(b.line) || a.index - b.index)
    .map((entry) => entry.line);
}

function closes(line: StatusLine): number {
  return line.verb === 'resolved' ? 1 : 0;
}

/** One comment as the board shows it: the text as written plus the verb line it carries, if any. */
export interface TicketCommentView {
  readonly author: string;
  readonly at: string;
  readonly text: string;
  /** The status verb of the first line; null for an ordinary comment. */
  readonly verb: StatusVerb | null;
  readonly key: string | null;
}

export function commentViewsOf(
  comments: readonly { readonly author: string; readonly at: string; readonly text: string }[],
): readonly TicketCommentView[] {
  // Same tie rule as statusLinesOfComments: inside one second a closing `resolved` comes last.
  return comments
    .map((comment, index) => {
      const line = parseStatusComment(comment.at, comment.text);
      const view: TicketCommentView = { author: comment.author, at: comment.at, text: comment.text, verb: line?.verb ?? null, key: line?.key ?? null };
      return { view, index };
    })
    .sort((a, b) => (a.view.at < b.view.at ? -1 : a.view.at > b.view.at ? 1 : 0) || Number(a.view.verb === 'resolved') - Number(b.view.verb === 'resolved') || a.index - b.index)
    .map((entry) => entry.view);
}
