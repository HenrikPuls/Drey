/**
 * Turns Markdown into the list of words worth spell-checking, with their
 * offsets in the original text. Pure and shared: the renderer builds
 * decorations from these offsets, the main process only ever sees the bare
 * words -- so the dictionary side never has to understand Markdown, and
 * the offsets can't drift between the two.
 *
 * Everything that is syntax rather than prose is masked out first: fenced
 * and inline code, YAML frontmatter, `#tags`, `[[wiki links]]`, URLs, link
 * targets and HTML comments. What survives is scanned for words.
 *
 * Hyphenated compounds are split at the hyphen and checked part by part.
 * German coins compounds freely (`Rollout-Plan`), and no Hunspell
 * dictionary lists them -- checking the whole compound would underline
 * correct text constantly, which is the fastest way to get a spellchecker
 * switched off for good.
 */

/** One checkable word and where it sits in the source text. */
export interface WordSpan {
  word: string;
  from: number;
  to: number;
}

/** Ranges of `text` that are syntax, not prose. */
function maskedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const push = (re: RegExp): void => {
    for (const match of text.matchAll(re)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  };

  // Leading YAML frontmatter.
  const frontmatter = /^---\n[\s\S]*?\n---(\n|$)/.exec(text);
  if (frontmatter) {
    ranges.push([0, frontmatter[0].length]);
  }

  push(/```[\s\S]*?(?:```|$)/g); // fenced code (unterminated fence masks to end)
  push(/`[^`\n]*`/g); // inline code
  push(/<!--[\s\S]*?(?:-->|$)/g); // HTML comments
  push(/<\/?[a-zA-Z][^>\n]*>/g); // HTML tags
  push(/\[\[[^\]\n]*\]\]/g); // wiki links
  push(/(?:^|(?<=\s))#[\p{L}\p{N}_\/-]+/gu); // inline tags
  push(/\b(?:https?|mailto|file|drey-asset):\S+/g); // URLs
  push(/\]\([^)\n]*\)/g); // link / image targets
  push(/(?:^|(?<=\s))[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-zA-Z]{2,}/gu); // e-mail

  return ranges.sort((a, b) => a[0] - b[0]);
}

function isMasked(ranges: ReadonlyArray<[number, number]>, from: number, to: number): boolean {
  // Ranges are sorted but may nest/overlap; the lists here are short
  // (one editor buffer), so a linear scan is cheaper than an index.
  return ranges.some(([start, end]) => from < end && to > start);
}

const WORD = /\p{L}[\p{L}\p{M}'’]*/gu;

/**
 * Every word in `text` that should be checked, in document order.
 * Skips words inside masked syntax, all-caps acronyms (`DB`, `API`) and
 * single letters.
 */
export function collectWords(text: string): WordSpan[] {
  const masked = maskedRanges(text);
  const out: WordSpan[] = [];

  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const from = match.index;
    const to = from + word.length;
    if (word.length < 2 || isMasked(masked, from, to)) {
      continue;
    }
    if (word === word.toUpperCase() && word !== word.toLowerCase()) {
      continue; // acronym
    }
    out.push({ word, from, to });
  }
  return out;
}

/** The distinct words of a text, for handing to the dictionary. */
export function distinctWords(spans: readonly WordSpan[]): string[] {
  return [...new Set(spans.map((span) => span.word))];
}

/** One dictionary verdict: a misspelled word and what to offer instead. */
export interface SpellIssue {
  word: string;
  suggestions: string[];
}

/**
 * Joins dictionary verdicts back onto the text's word spans. Words the
 * checker did not flag simply produce no span.
 */
export function issueSpans(
  spans: readonly WordSpan[],
  issues: ReadonlyMap<string, readonly string[]>,
): Array<WordSpan & { suggestions: readonly string[] }> {
  const out: Array<WordSpan & { suggestions: readonly string[] }> = [];
  for (const span of spans) {
    const suggestions = issues.get(span.word);
    if (suggestions) {
      out.push({ ...span, suggestions });
    }
  }
  return out;
}
