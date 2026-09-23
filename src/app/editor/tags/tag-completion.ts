import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { TagEntry } from '../../../../shared/plugin-api/search-types';
import { tagChipColors } from '../../../../shared/tag-style';
import { inCompletableText, markdownContextAt } from '../markdown-context';

/**
 * `#tag` completion against the live tag vocabulary (milestone 33: a BASE
 * editor feature, fed by `TagVocabularyService` — the tags plugin stays the
 * data owner over the section-search provider). Ranked by use then name;
 * `/` is allowed so a nested tag (`#project/frontend`) completes segment by
 * segment; options render with the tag's resolved prefix/auto color.
 * Silent inside code, frontmatter, links and raw HTML (the shared
 * Markdown-context gate) — a `#` there is code or a YAML comment, not a tag.
 */

export interface TagCompletionConfig {
  getTags: () => readonly TagEntry[];
  /** Resolved display color for one tag; omit for uncolored options. */
  colorFor?: (tag: string) => string;
}

export function makeTagCompletionSource(config: TagCompletionConfig) {
  return (context: CompletionContext): CompletionResult | null => {
    // The canonical grammar is `TAG_NAME_SOURCE` in shared/tag-grammar.
    const token = context.matchBefore(/#[\p{L}\p{N}_/-]*/u);
    if (!token || (token.from === token.to && !context.explicit)) {
      return null;
    }
    if (!inCompletableText(markdownContextAt(context.state, context.pos))) {
      return null;
    }

    const query = token.text.slice(1).toLowerCase();
    const matches = config
      .getTags()
      .filter((entry) => entry.tag.startsWith(query))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    if (matches.length === 0) {
      return null;
    }

    const options: Completion[] = matches.map((entry) => {
      const color = config.colorFor?.(entry.tag);
      return {
        label: `#${entry.tag}`,
        apply: `#${entry.tag} `,
        detail: `${entry.count}×`,
        ...(color !== undefined
          ? {
              render: () => {
                const { fg, bg } = tagChipColors(color);
                const el = document.createElement('span');
                el.className = 'cm-tag-option';
                el.style.color = fg;
                el.style.backgroundColor = bg;
                el.textContent = `#${entry.tag}`;
                return el;
              },
            }
          : {}),
      };
    });

    return { from: token.from, options, validFor: /^#[\p{L}\p{N}_/-]*$/u };
  };
}
