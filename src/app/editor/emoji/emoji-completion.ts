import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { emojiFor, searchEmojiNames } from '../../../../shared/markdown/emoji';
import { inCompletableText, markdownContextAt } from '../markdown-context';

/**
 * `:shortcode:` completion over the curated gemoji table (milestone 72,
 * ADR-0070) -- the typing twin of the picker: typing `:jo` in prose opens
 * CodeMirror's popup with the matching names (recently picked ones first),
 * Enter lands `:joy:`.
 *
 * Only a colon that OPENS a shortcode ever fires: the character before it
 * must be line start, whitespace or an opening punctuation mark -- so
 * times (`12:30`, `00:03:48`), URLs (`https:`) and prose colons (`Note:`)
 * stay quiet, on top of the curated table itself only knowing GitHub's
 * names. Silent inside code, frontmatter, links, raw HTML and math (the
 * shared Markdown-context gate); not mounted on the Enter-submits
 * composers, where the popup would swallow the submit key.
 */
export interface EmojiCompletionConfig {
  /** Recently picked names, ranked ahead of the alphabetical order. */
  getRecents?: () => readonly string[];
}

/** How many options the popup offers per keystroke (scrollable inside it). */
const MAX_OPTIONS = 60;

export function makeEmojiCompletionSource(config: EmojiCompletionConfig = {}) {
  return (context: CompletionContext): CompletionResult | null => {
    const token = context.matchBefore(/:[a-zA-Z0-9_+-]*:?/);
    if (!token) {
      return null;
    }
    // The colon must open the shortcode, not close something else.
    if (token.from > 0 && !/[\s([{"'«„>]$/.test(context.state.sliceDoc(token.from - 1, token.from))) {
      return null;
    }
    const query = token.text.replace(/^:|:$/g, '').toLowerCase();
    if (query === '') {
      return null; // the bare colon never opens the list
    }
    if (!inCompletableText(markdownContextAt(context.state, context.pos))) {
      return null;
    }

    const matches = searchEmojiNames(query, MAX_OPTIONS);
    if (matches.length === 0) {
      return null;
    }
    const recents = new Set(config.getRecents?.() ?? []);
    const ranked = [...matches].sort(
      (a, b) => Number(recents.has(b)) - Number(recents.has(a)),
    );
    const options: Completion[] = ranked.map((name) => ({
      label: `:${name}:`,
      detail: emojiFor(name) ?? '',
      apply: `:${name}:`,
    }));
    // Pre-filtered above (prefix, then substring; recents hoisted) --
    // CodeMirror's fuzzy matcher would only re-rank it.
    return { from: token.from, options, filter: false, validFor: /^:[a-zA-Z0-9_+-]*:?$/ };
  };
}
