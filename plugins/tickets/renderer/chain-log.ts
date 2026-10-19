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
 * Plain log text as Markdown paragraphs, one per line, with no fence: the
 * view shows ordinary text the owner can mark and copy line by line. Only
 * what would turn a line into something else is escaped — a block marker
 * at its start (heading, quote, list, fence, table) and the inline
 * `*`, backtick and `<` — so a normal log line is copied unchanged.
 * Indentation is dropped (four spaces would start a code block).
 */
export function asParagraphs(text: string): string {
  return text
    .split('\n')
    .map((raw) => raw.trim())
    .filter((line) => line !== '')
    .map((line) =>
      line
        .replace(/^([#>|~+-]|\d+[.)]\s|`{3})/, '\\$1')
        .replace(/([*`<])/g, '\\$1'),
    )
    .join('\n\n');
}
