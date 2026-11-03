/**
 * Line comments on the diff (E11-3, concept v2, owner decision D6): the
 * owner's review comments travel with a send-back as structured feedback
 * (file, line, text) and land in the ticket's `## Handover` as a
 * `### Review feedback` block the responsible persona reads on its next
 * run. A new send-back replaces the previous block. Specification:
 * specs/ticket-schema.md, "Review feedback".
 */

export interface ReviewComment {
  /** Repo-relative path of the commented file. */
  readonly file: string;
  /** The line in the NEW file; for a range, its first line. */
  readonly line: number;
  /** The range's last line; null = a single line. */
  readonly endLine: number | null;
  readonly text: string;
}

export const MAX_REVIEW_COMMENTS = 50;
export const MAX_REVIEW_COMMENT_CHARS = 1000;
export const FEEDBACK_HEADING = '### Review feedback';

/**
 * Reads the comments of a request body: anything that is not a well-formed
 * comment is dropped, the list is capped, texts are trimmed and cut. An
 * unreadable input is an empty list, never a throw.
 */
export function parseReviewComments(raw: unknown): ReviewComment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ReviewComment[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const r = item as Record<string, unknown>;
    const file = typeof r['file'] === 'string' ? r['file'].trim() : '';
    const text = typeof r['text'] === 'string' ? r['text'].replace(/\s+/g, ' ').trim() : '';
    const line = r['line'];
    const endLine = r['endLine'];
    if (file === '' || file.length > 300 || /[`\n\r]/.test(file) || text === '') {
      continue;
    }
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      continue;
    }
    const end =
      typeof endLine === 'number' && Number.isInteger(endLine) && endLine > line ? endLine : null;
    out.push({ file, line, endLine: end, text: text.slice(0, MAX_REVIEW_COMMENT_CHARS) });
    if (out.length >= MAX_REVIEW_COMMENTS) {
      break;
    }
  }
  return out;
}

/** `src/a.ts:27` or `src/a.ts:30-33`. */
export function commentLocation(comment: ReviewComment): string {
  return comment.endLine === null ? `${comment.file}:${comment.line}` : `${comment.file}:${comment.line}-${comment.endLine}`;
}

/** The block, heading included, ending in one newline. */
export function renderFeedbackBlock(comments: readonly ReviewComment[]): string {
  const lines = [FEEDBACK_HEADING, ''];
  for (const comment of comments) {
    lines.push(`- \`${commentLocation(comment)}\` — ${comment.text}`);
  }
  return `${lines.join('\n')}\n`;
}

const LINE = /^- `([^`:]+):(\d+)(?:-(\d+))?` — (.+)$/;

/** Reads the block back (the persona-facing text round trip); empty when absent. */
export function parseFeedbackBlock(ticketText: string): ReviewComment[] {
  const at = ticketText.indexOf(`\n${FEEDBACK_HEADING}\n`);
  if (at < 0) {
    return [];
  }
  const rest = ticketText.slice(at + FEEDBACK_HEADING.length + 2);
  const end = /^#{1,3} /m.exec(rest);
  const comments: ReviewComment[] = [];
  for (const line of (end === null ? rest : rest.slice(0, end.index)).split(/\r?\n/)) {
    const match = LINE.exec(line.trim());
    if (match !== null) {
      const first = Number(match[2]);
      const last = match[3] === undefined ? null : Number(match[3]);
      comments.push({ file: match[1]!, line: first, endLine: last, text: match[4]! });
    }
  }
  return comments;
}

/**
 * Puts the block into `## Handover` (the section is created before
 * `## Log` when missing), replacing an earlier `### Review feedback`.
 * Everything else in the file survives byte for byte.
 */
export function withReviewFeedback(ticketText: string, comments: readonly ReviewComment[]): string {
  if (comments.length === 0) {
    return ticketText;
  }
  const text = ticketText.replace(/\r\n/g, '\n');
  const block = renderFeedbackBlock(comments);
  const heading = /^## Handover[ \t]*$/m.exec(text);
  if (heading === null) {
    const section = `## Handover\n\n${block}`;
    const log = /^## Log[ \t]*$/m.exec(text);
    return log === null
      ? `${text.replace(/\n*$/, '')}\n\n${section}`
      : `${text.slice(0, log.index)}${section}\n${text.slice(log.index)}`;
  }
  const bodyStart = heading.index + heading[0].length;
  const next = /^## /m.exec(text.slice(bodyStart));
  const bodyEnd = next === null ? text.length : bodyStart + next.index;
  let body = text.slice(bodyStart, bodyEnd);
  const old = new RegExp(`^${FEEDBACK_HEADING}[ \\t]*\\n[\\s\\S]*?(?=^#{1,3} |$(?![\\s\\S]))`, 'm').exec(body);
  if (old !== null) {
    body = body.slice(0, old.index) + body.slice(old.index + old[0].length);
  }
  body = body.replace(/\n+$/, '\n');
  const tail = next === null ? '' : '\n';
  return `${text.slice(0, bodyStart)}${body === '' || body === '\n' ? '\n' : body}\n${block}${tail}${text.slice(bodyEnd)}`;
}
