import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { Text } from '@codemirror/state';
import { inCompletableText, markdownContextAt } from '../markdown-context';

/**
 * Word completion: repeat what the note already says. The vocabulary is the
 * current document only (frequency-ranked); a typed fragment of three or
 * more word characters opens the popup, options carry a negative boost so
 * `#tag` and `[[wikilink]]` candidates keep precedence wherever they also
 * apply. The shared Markdown-context gate keeps the popup out of code,
 * frontmatter, links, raw HTML and `#`/`[[` tokens -- prose, headings and
 * table cells are the point.
 *
 * Cost shape: the harvest (one line scan + sort) runs only when a popup
 * session opens -- while it stays open, `validFor` lets the completion
 * system re-filter synchronously instead of re-querying the source, so
 * typing through a suggestion costs one array pass, not a re-scan. The
 * cache key is the `Text` object's identity; every transaction mints a new
 * one, so a document edit is an exact invalidation.
 */

export interface WordCompletionConfig {
  /** Shortest typed fragment that may open the popup (default 3). */
  minWordLength?: number;
  /** Upper bound on offered options (default 20). */
  maxOptions?: number;
}

const DEFAULT_MIN = 3;
const DEFAULT_MAX = 20;

const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;
const WORD_GLOBAL = /[\p{L}\p{N}_][\p{L}\p{N}_-]*/gu;
const VALID = /^[\p{L}\p{N}_-]*$/u;

interface WordCount {
  word: string;
  count: number;
}

/** Whole-document vocabulary, most frequent first (deterministic tie-break). */
function harvest(doc: Text): WordCount[] {
  const counts = new Map<string, number>();
  for (const line of doc.iterLines()) {
    for (const match of line.matchAll(WORD_GLOBAL)) {
      counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}

export function makeWordCompletionSource(config: WordCompletionConfig = {}) {
  const min = config.minWordLength ?? DEFAULT_MIN;
  const max = config.maxOptions ?? DEFAULT_MAX;
  let vocabularyDoc: Text | null = null;
  let vocabulary: WordCount[] = [];

  return (context: CompletionContext): CompletionResult | null => {
    const token = context.matchBefore(WORD);
    if (!token || token.to - token.from < min) {
      return null;
    }
    if (!inCompletableText(markdownContextAt(context.state, context.pos))) {
      return null;
    }

    if (vocabularyDoc !== context.state.doc) {
      vocabularyDoc = context.state.doc;
      vocabulary = harvest(vocabularyDoc);
    }

    const partial = token.text.toLowerCase();
    const options: Completion[] = [];
    for (const { word, count } of vocabulary) {
      // The fragment as typed is what the user already has; only its
      // longer siblings are worth offering.
      if (word === token.text || !word.toLowerCase().startsWith(partial)) {
        continue;
      }
      options.push({ label: word, detail: `${count}×`, boost: -30 });
      if (options.length >= max) {
        break;
      }
    }
    if (options.length === 0) {
      return null;
    }
    return { from: token.from, options, validFor: VALID };
  };
}
