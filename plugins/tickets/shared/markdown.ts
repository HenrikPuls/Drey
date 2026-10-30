/**
 * The pure halves of the reply Markdown subset (req-58): one canonical
 * inline parser and the pipe-row splitter, shared by the desk transcript
 * renderer (`renderer/transcript-text.ts`) and the remote client
 * (`remote/markdown.ts`). Pure text in, plain data out — no DOM, so it
 * stays usable in any bundle.
 */
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])/g;

/** One inline span of a reply line. */
export type ReplySpan =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'bold'; readonly text: string }
  | { readonly kind: 'italic'; readonly text: string };

/** Splits a line into plain, code, bold and italic spans (one non-nested pass). */
export function parseReplyInline(text: string): ReplySpan[] {
  const spans: ReplySpan[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > cursor) {
      spans.push({ kind: 'text', text: text.slice(cursor, match.index) });
    }
    if (match[1] !== undefined) {
      spans.push({ kind: 'code', text: match[1] });
    } else if (match[2] !== undefined) {
      spans.push({ kind: 'bold', text: match[2] });
    } else {
      spans.push({ kind: 'italic', text: match[3] ?? match[4] ?? '' });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    spans.push({ kind: 'text', text: text.slice(cursor) });
  }
  return spans;
}

/** `| a | b |` as its trimmed cells. */
export function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}
