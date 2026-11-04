/**
 * Fenced code is opaque (milestone 148, E10-7): a ticket document may
 * carry a Mermaid diagram (or any other fenced block) whose lines happen
 * to look like structure -- `## Plan`, `### Parts`, `- [ ] step`,
 * `persona: ben`, a Log line. Every reader of ticket text (the engine's
 * parsers, the patchers, Mission Control's models) looks at the text
 * through {@link maskFences}, so such lines are invisible to it, while
 * every offset it computes still indexes the original text -- the write
 * path slices the original and so keeps a fence byte for byte.
 *
 * The rule (CommonMark, plus one tolerance):
 *   - a fence opens on a line of three or more backticks or tildes, after
 *     any indentation, list marker or `>` quote prefix; a backtick fence's
 *     info string may not contain a backtick (so a line like "```x```" is
 *     inline code, not a fence);
 *   - it closes on a line of the same character, at least as long, with
 *     nothing after it but whitespace;
 *   - a fence that never closes ends at the next level-2 heading in column
 *     0 (or the end of the text), so a forgotten closing fence cannot
 *     swallow the Verification and Log chapters that follow it.
 */

const PREFIX = String.raw`[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+|>[ \t]?)*`;
const OPEN = new RegExp(`^${PREFIX}(\`{3,}|~{3,})(.*)$`);
const CLOSE = new RegExp(`^${PREFIX}(\`{3,}|~{3,})[ \\t]*$`);

interface FenceOpen {
  readonly char: string;
  readonly length: number;
}

function openingFence(line: string): FenceOpen | null {
  const match = OPEN.exec(line);
  if (match === null) {
    return null;
  }
  const marker = match[1]!;
  if (marker.startsWith('`') && match[2]!.includes('`')) {
    return null;
  }
  return { char: marker[0]!, length: marker.length };
}

function closesFence(line: string, open: FenceOpen): boolean {
  const match = CLOSE.exec(line);
  return match !== null && match[1]![0] === open.char && match[1]!.length >= open.length;
}

/**
 * Per line: whether it belongs to a fence (delimiters included). A line
 * may carry a trailing `\r` (CRLF files).
 */
export function fencedLineFlags(lines: readonly string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false);
  const bare = (index: number): string => lines[index]!.replace(/\r$/, '');
  let i = 0;
  while (i < lines.length) {
    const open = openingFence(bare(i));
    if (open === null) {
      i++;
      continue;
    }
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closesFence(bare(j), open)) {
        close = j;
        break;
      }
    }
    if (close < 0) {
      close = lines.length - 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (bare(j).startsWith('## ')) {
          close = j - 1;
          break;
        }
      }
    }
    for (let k = i; k <= close; k++) {
      flags[k] = true;
    }
    i = close + 1;
  }
  return flags;
}

/**
 * `text` with every fenced line blanked to spaces: same length, same
 * newlines (a `\r` stays), so a regex match or a line index found in the
 * masked text addresses the same place in the original.
 */
export function maskFences(text: string): string {
  if (!text.includes('```') && !text.includes('~~~')) {
    return text;
  }
  const lines = text.split('\n');
  const flags = fencedLineFlags(lines);
  return lines.map((line, i) => (flags[i] ? line.replace(/[^\r]/g, ' ') : line)).join('\n');
}

/** `lines` with the fenced ones blanked; same count, same order. */
export function maskFenceLines(lines: readonly string[]): string[] {
  const flags = fencedLineFlags(lines);
  return lines.map((line, i) => (flags[i] ? line.replace(/[^\r]/g, ' ') : line));
}
