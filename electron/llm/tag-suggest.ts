/**
 * The vocabulary-based tag suggestion behind the editor's `⋯` "Suggest
 * tags" row (and `ctx.llm.suggestTags` for plugins): one note section + the
 * vault's tag vocabulary in, up to four suggested tags out (normalised,
 * de-duplicated).
 *
 * Extracted from the pre-conversion `ActionRunner` (ADR-0044 stage 7): the
 * action *engine* moved into the assistant plugin, but the Autotag stays a
 * base surface -- it writes into the base editor (the "Suggest tags" row,
 * the removed entry drawer's old button) and joins the Tags plugin's
 * vocabulary (via the section-search provider) with the base LLM transport,
 * so neither side owns it alone. Uses the editable `autotag` built-in
 * template. Cancellable via `taskId`.
 */
import { AUTOTAG_PROMPT } from '../../shared/app-config';
import type { ActionsConfig } from '../../shared/app-config';
import { parseSuggestedTags, substituteVocabulary } from '../../shared/llm';
import { LlmClient } from './llm-client';
import { LlmTaskRegistry } from './llm-tasks';

export class TagSuggester {
  constructor(
    /**
     * The actions config (the assistant plugin's own config since the
     * ADR-0010 later change), read fresh per call and normalized by the
     * host seam that hands this in.
     */
    private readonly readActions: () => Promise<ActionsConfig>,
    private readonly llmEnabled: () => boolean,
    private readonly llm: LlmClient,
    private readonly tasks: LlmTaskRegistry,
  ) {}

  /**
   * `[]` when nothing usable came back; throws only when LLM features are
   * off or the call fails.
   */
  async suggest(entryText: string, vocabulary: string[], taskId?: string): Promise<string[]> {
    if (!this.llmEnabled()) {
      throw new Error('LLM features are disabled.');
    }
    if (entryText.trim() === '') {
      return [];
    }
    const actions = await this.readActions();
    const template = actions.templates.find((entry) => entry.builtin === 'autotag');
    // The shared `{{AVAILABLE_TAGS}}` placeholder — the legacy `{tags}`
    // spelling is substituted too, so a stored edited prompt keeps working.
    const system = substituteVocabulary(template?.prompt ?? AUTOTAG_PROMPT, vocabulary);
    const reply = await this.tasks.run(taskId, (signal) =>
      this.llm.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: entryText },
        ],
        { signal },
      ),
    );
    return parseSuggestedTags(reply.text);
  }
}
