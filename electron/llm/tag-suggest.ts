/**
 * The vocabulary-based tag suggestion behind the drawer's "Autotag" button
 * (and `ctx.llm.suggestTags` for plugins): the entry text + the vault's tag
 * vocabulary in, up to four suggested tags out (normalised, de-duplicated).
 *
 * Extracted from the pre-conversion `ActionRunner` (ADR-0044 stage 7): the
 * action *engine* moved into the assistant plugin, but the Autotag stays a
 * base surface — it writes into the base entry drawer and joins the Tags
 * plugin's vocabulary (via the section-search provider) with the base LLM
 * transport, so neither side owns it alone. Uses the editable `autotag`
 * built-in template. Cancellable via `taskId`.
 */
import { AUTOTAG_PROMPT } from '../../shared/app-config';
import { parseSuggestedTags } from '../../shared/llm';
import { AppConfigStore } from '../app-config';
import { LlmClient } from './llm-client';
import { LlmTaskRegistry } from './llm-tasks';

export class TagSuggester {
  constructor(
    private readonly config: AppConfigStore,
    private readonly llm: LlmClient,
    private readonly tasks: LlmTaskRegistry,
  ) {}

  /**
   * `[]` when nothing usable came back; throws only when LLM features are
   * off or the call fails.
   */
  async suggest(entryText: string, vocabulary: string[], taskId?: string): Promise<string[]> {
    if (!this.config.get().llm.enabled) {
      throw new Error('LLM features are disabled.');
    }
    if (entryText.trim() === '') {
      return [];
    }
    const template = this.config
      .get()
      .actions.templates.find((entry) => entry.builtin === 'autotag');
    const system = (template?.prompt ?? AUTOTAG_PROMPT).replace(
      '{tags}',
      vocabulary.length > 0 ? vocabulary.join('\n') : '(none yet)',
    );
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
