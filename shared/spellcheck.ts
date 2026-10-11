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
 * switched off for good. Closed compounds (`Testfall`) get the same
 * treatment on the verdict side, via `compoundAcceptable` below -- nspell
 * does not evaluate the Hunspell `COMPOUND*` rules the dictionaries
 * declare.
 */

import type { SpellcheckConfig } from './app-config';

/** One checkable word and where it sits in the source text. */
export interface WordSpan {
  word: string;
  from: number;
  to: number;
}

/**
 * The extra words a given dictionary should accept: the global personal
 * list plus any words pinned to this dictionary id, de-duplicated and
 * newline-joined for `nspell.personal()`. `''` when there are none.
 */
export function personalDictionaryFor(config: SpellcheckConfig, language: string): string {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const raw of [...config.personalWords, ...(config.languageWords[language] ?? [])]) {
    const word = raw.replace(/[\r\n]+/g, ' ').trim();
    if (word !== '' && !seen.has(word)) {
      seen.add(word);
      words.push(word);
    }
  }
  return words.join('\n');
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
  push(/\$\$[\s\S]*?\$\$/g); // display math (terminated pair)
  // Inline math with no edge spaces, so "costs $5 and $6" keeps its
  // words checkable (the closing `$` must not follow a space).
  push(/\$[^$\s](?:[^$\n]*[^$\s])?\$/g);
  push(/\[\^[^\]\n]+\]/g); // footnote refs and definition labels
  push(/:[a-zA-Z0-9_+-]+:/g); // emoji shortcodes
  push(/\[![a-zA-Z]+\][+-]?/g); // callout markers

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

/**
 * Joins the dictionary's misspelling verdicts back onto the text's word
 * spans. Suggestions are deliberately not part of this: the bulk check is
 * verdict-only (suggest is the expensive operation), so the flagged spans
 * carry no suggestion text -- the popup fetches those per word.
 */
export function issueSpans(
  spans: readonly WordSpan[],
  misspelled: ReadonlySet<string>,
): WordSpan[] {
  return spans.filter((span) => misspelled.has(span.word));
}

/**
 * German coins compounds freely, and no Hunspell dictionary lists them
 * all -- the bundled German one declares the Hunspell `COMPOUND*` rules,
 * but nspell (a partial Hunspell reimplementation) does not evaluate
 * them, so every closed compound not literally in the dictionary
 * ("Testfall", "Krankenhaus", "Arbeitsspeicher") would be flagged. That
 * is the fastest way to get a spellchecker switched off for good, so the
 * verdict falls back to this splitter: `word` counts as acceptable when
 * it decomposes into accepted parts (Fugenelemente like the "s" in
 * "Arbeitsspeicher" consumed along the way).
 *
 * `has` is the dictionary's case-tolerant verdict for one word. The
 * trade-off is deliberate: every concatenation of valid words is
 * accepted ("Hausbaum"), i.e. the splitter errs towards silence -- a
 * missed squiggle annoys far less than a wrong one on correct text.
 *
 * The scan is cheap (`correct` is a dictionary lookup, ~µs) and only ever
 * runs for words the dictionary rejected outright.
 */

/** Shortest part worth looking up -- keeps the split positions sane. */
const MIN_PART = 3;
/** Fugenelemente consumed between parts, longest first. */
const FUGES = ['es', 'en', 's', 'n', 'e'] as const;
/** Compound depth -- "Geschwindigkeitsbegrenzung" is two parts + Fuge. */
const MAX_PARTS = 3;

export function compoundAcceptable(has: (word: string) => boolean, word: string): boolean {
  if (word.length < 2 * MIN_PART) {
    return false;
  }
  return partsAcceptable(has, word, MAX_PARTS);
}

function partsAcceptable(has: (word: string) => boolean, word: string, depth: number): boolean {
  if (has(word)) {
    return true;
  }
  if (depth <= 1) {
    return false;
  }
  for (let cut = MIN_PART; cut <= word.length - MIN_PART; cut++) {
    if (!has(word.slice(0, cut))) {
      continue;
    }
    const rest = word.slice(cut);
    if (partsAcceptable(has, rest, depth - 1)) {
      return true;
    }
    for (const fuge of FUGES) {
      if (rest.startsWith(fuge) && partsAcceptable(has, rest.slice(fuge.length), depth - 1)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Levenshtein distance, two-row DP. Suggestion ranking uses it: nspell's
 * own suggest order is unreliable for compound typos (its candidates are
 * not distance-ranked once its ngram search has nothing anchor on), and
 * the recombinators' output needs to compete with it on equal terms.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Suggestion synthesis for rejected compounds. The dictionary's own
 * `suggest` cannot help here -- nspell searches the dictionary's words,
 * and the compound (typo and correction alike) is not in it, so the
 * popup would show nothing for a squiggle that is entirely justified.
 *
 * This walks the same split positions as `compoundAcceptable` and looks
 * for cuts where exactly one half is accepted: the broken half is sent
 * to `suggest` on its own (a fragment the dictionary *does* have
 * neighbours for), stripped of a leading Fuge first if it has one, and
 * the results are re-joined into whole-word candidates
 * ("Krankehnhaus": "Kranken"? no -- "krankehn" suggests "kranken", join
 * with "haus" -> "Krankenhaus"). Candidates survive only if `has`
 * accepts the joined word, and the input itself is excluded -- a
 * fragment suggestion can legitimately reconstruct the original typo.
 *
 * `suggest` is the raw per-word dictionary lookup (tens of ms per call),
 * which is why this runs only in the lazy, per-click suggestion path --
 * never inside the bulk verdict check.
 */
export function compoundSuggestions(
  suggest: (word: string) => string[],
  has: (word: string) => boolean,
  word: string,
): string[] {
  if (word.length < 2 * MIN_PART) {
    return [];
  }
  const capitalized = word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();
  const out: string[] = [];

  for (let cut = MIN_PART; cut <= word.length - MIN_PART; cut++) {
    const left = word.slice(0, cut);
    const right = word.slice(cut);
    const leftOk = has(left);
    if (leftOk === has(right)) {
      // Both halves fine -> not what the squiggle is about; both broken
      // -> no anchor to re-join against.
      continue;
    }
    const known = leftOk ? left : right;
    const unknown = leftOk ? right : left;
    // The broken half is replaced by its suggestion: if it sat on the
    // right, the known half comes first ("Krankehn" + "haus" -> the fix
    // lands in the middle); if it sat on the left, the suggestion does.
    collectRecombinations(
      out,
      suggest,
      has,
      known,
      unknown,
      word,
      capitalized,
      /* knownFirst */ leftOk,
    );
  }
  return out;
}

/**
 * Joins `known` with every suggestion for the (Fuge-stripped) `unknown`
 * half, in the order the halves occur in the word. Suggestion case is
 * flattened before the original's leading case is restored, so
 * "Schreibt" + "Tisch" becomes "Schreibtisch" rather than
 * "SchreibtTisch".
 */
function collectRecombinations(
  out: string[],
  suggest: (word: string) => string[],
  has: (word: string) => boolean,
  known: string,
  unknown: string,
  original: string,
  capitalized: boolean,
  knownFirst: boolean,
): void {
  const pieces: Array<[fuge: string, tail: string]> = [['', unknown]];
  for (const fuge of FUGES) {
    if (unknown.startsWith(fuge)) {
      pieces.push([fuge, unknown.slice(fuge.length)]);
    }
  }
  for (const [fuge, tail] of pieces) {
    for (const suggestion of suggest(tail)) {
      const joined = knownFirst
        ? known + fuge + suggestion
        : suggestion + fuge + known;
      const candidate = joined.toLowerCase();
      const final = capitalized
        ? candidate.charAt(0).toUpperCase() + candidate.slice(1)
        : candidate;
      if (
        final.toLowerCase() !== original.toLowerCase() &&
        has(final) &&
        !out.includes(final)
      ) {
        out.push(final);
      }
    }
  }
}
