/**
 * `ClassifierService` (CLAUDE.md, "Relevant Components"): wraps the two
 * prompts from `specs/classifier-spec.md` around `LmStudioClient`. Message
 * building and reply parsing are the pure `shared/classifier.ts`; this only
 * sequences the call.
 *
 * Prompt 1 (task vs. note) is here for completeness of the component;
 * milestone-7 capture will call it. The Actions system only uses Prompt 2
 * (batch tag suggestion) so far -- through `ActionRunner`.
 */
import {
  TagSuggestion,
  TaskClassification,
  buildTagSuggestionMessages,
  buildTaskMessages,
  parseTagSuggestion,
  parseTaskClassification,
} from '../shared/classifier';
import { LmStudioClient } from './lm-studio-client';

export class ClassifierService {
  constructor(private readonly llm: LmStudioClient) {}

  /**
   * Prompt 2. `systemPrompt` is the Autotagging template's prompt text
   * (with a `{registry_list}` placeholder), `registryText` the rendered
   * tag registry, `noteText` the untagged content. `null` when the reply
   * has no usable suggestion.
   */
  async suggestTags(
    systemPrompt: string,
    registryText: string,
    noteText: string,
    signal?: AbortSignal,
  ): Promise<TagSuggestion | null> {
    const reply = await this.llm.chat(
      buildTagSuggestionMessages(systemPrompt, registryText, noteText),
      { signal },
    );
    return parseTagSuggestion(reply);
  }

  /** Prompt 1. `null` when the reply doesn't parse to a task/notiz decision. */
  async classifyEntry(text: string, signal?: AbortSignal): Promise<TaskClassification | null> {
    const reply = await this.llm.chat(buildTaskMessages(text), { signal });
    return parseTaskClassification(reply);
  }
}
