/**
 * Extraction of the rewritten document from an Ask reply (ADR-0053): for
 * a change, the model returns the complete document inside a fenced block
 * whose info string is `document`. The prompts instruct FOUR backticks,
 * so a document body containing ordinary ``` fences cannot close the
 * block early (CommonMark: a closing fence needs at least as many
 * backticks as the opener). This replaces the old JSON envelope, whose
 * parse failures degraded the raw JSON into a chat answer card.
 *
 * Pure string shaping; the chat engine turns a found document into an
 * edit outcome and everything else into a plain answer.
 */

export interface DocumentFence {
  document: string;
}

/**
 * Scans the reply for `document` fences and returns the best candidate:
 * the block with the LONGEST body (ties go to the LAST — a corrected
 * restatement comes last). Heal fallback: when the reply is nothing but
 * ONE fenced block of any info string (a ```markdown-wrapped document),
 * that block is accepted. Returns null when neither applies — the engine
 * then treats the reply as a plain answer.
 */
export function extractDocumentFence(reply: string): DocumentFence | null {
  const lines = reply.replace(/\r\n/g, '\n').split('\n');
  let best: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})\s*document\s*$/.exec(lines[i]);
    if (open === null) {
      continue;
    }
    const close = findClosingFence(lines, i + 1, open[1].length);
    if (close === -1) {
      continue;
    }
    const body = lines.slice(i + 1, close).join('\n');
    if (best === null || body.length >= best.length) {
      best = body;
    }
    i = close; // skip past this block
  }
  if (best !== null) {
    return { document: normalize(best) };
  }
  return healSingleFence(lines);
}

/** First line from `from` on that is only backticks, at least `n` of them. */
function findClosingFence(lines: readonly string[], from: number, n: number): number {
  for (let i = from; i < lines.length; i++) {
    if (/^`{3,}$/.test(lines[i]) && lines[i].length >= n) {
      return i;
    }
  }
  return -1;
}

/**
 * The heal: a reply that is a single fenced block (any info string) with
 * no other non-blank content around it. Anything else — prose around the
 * fence, several blocks — stays an answer.
 */
function healSingleFence(lines: readonly string[]): DocumentFence | null {
  let open = -1;
  let backticks = 3;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(`{3,})/.exec(lines[i]);
    if (m !== null) {
      open = i;
      backticks = m[1].length;
      break;
    }
  }
  if (open === -1) {
    return null;
  }
  const close = findClosingFence(lines, open + 1, backticks);
  if (close === -1) {
    return null;
  }
  const blank = (line: string): boolean => line.trim() === '';
  if (!lines.slice(0, open).every(blank) || !lines.slice(close + 1).every(blank)) {
    return null;
  }
  return { document: normalize(lines.slice(open + 1, close).join('\n')) };
}

function normalize(body: string): string {
  return `${body.trim()}\n`;
}
