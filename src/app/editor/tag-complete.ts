import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { TagEntry } from '../../../shared/ipc-api';

/** A synchronous CodeMirror completion source (structurally a `CompletionSource`). */
export type SyncCompletionSource = (context: CompletionContext) => CompletionResult | null;

/**
 * CodeMirror 6 completion source for inline `#tag`s. Pure and
 * dependency-injected (`getTags` reads the live `TagService` signal) so it
 * is unit-testable with a hand-built context, and so a vault change is
 * picked up without rebuilding the editor.
 *
 * `basicSetup` already provides the `autocompletion()` extension and its
 * keymap; this only needs registering as a language-data `autocomplete`
 * source (see `editor.ts`). Ranked by how many sections use the tag, then
 * alphabetically.
 */
export function makeTagCompletionSource(getTags: () => readonly TagEntry[]): SyncCompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const token = context.matchBefore(/#[\p{L}\p{N}_-]*/u);
    if (!token || (token.from === token.to && !context.explicit)) {
      return null;
    }

    const query = token.text.slice(1).toLowerCase();
    const matches = getTags().filter((entry) => entry.tag.startsWith(query));
    if (matches.length === 0) {
      return null;
    }

    const options: Completion[] = [...matches]
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .map((entry) => ({
        label: `#${entry.tag}`,
        apply: `#${entry.tag} `,
        detail: `${entry.count}×`,
      }));

    return { from: token.from, options, validFor: /^#[\p{L}\p{N}_-]*$/u };
  };
}
