/** Pure helpers of the chain-log tab's Clear. */

/** The daemon's line shape is `[fleet <ISO timestamp>] <message>`. */
export function chainLogStamp(line: string): string {
  const match = /^\[fleet (\S+)\]/.exec(line);
  return match?.[1] ?? '';
}

/** The lines newer than the last clear; an unstamped line follows its predecessor. */
export function visibleChainLog(text: string, clearedAt: string): string {
  if (clearedAt === '') {
    return text;
  }
  const kept: string[] = [];
  let visible = false;
  for (const line of text.split('\n')) {
    const stamp = chainLogStamp(line);
    if (stamp !== '') {
      visible = stamp > clearedAt;
    }
    if (visible) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

/**
 * Wraps plain text in a fenced code block for the Markdown view: line
 * breaks stay line breaks and nothing in a log line is read as Markdown.
 * The fence is longer than any backtick run inside the text, so a line
 * that itself holds a fence cannot close the block early.
 */
export function asCodeBlock(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}\n`;
}
