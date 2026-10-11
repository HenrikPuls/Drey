/**
 * IPC contract, tag part: the tag vocabulary over the section-search
 * provider and the "Suggest tags" call (ADR-0017)
 * (`shared/ipc-api.ts` is the barrel).
 */

/**
 * One tag in the vault-wide vocabulary, for `#tag` autocomplete and the
 * search panel's tag picker. `count` is how many heading-sections carry
 * the tag (`electron/tags/TagIndex`).
 */
export interface TagEntry {
  tag: string;
  count: number;
}

/**
 * The vocabulary + prefix-style payload the section-search provider serves
 * (see `search:vocabulary`). Empty when no provider is registered (e.g. the
 * tags plugin is disabled) — consumers degrade to no completion / auto
 * colors.
 */
export interface TagVocabularyPayload {
  entries: TagEntry[];
  prefixes: Array<{ prefix: string; color: string }>;
}

/** Tag suggestions and the tag vocabulary. */
export interface TagsIpc {
  /**
   * The editor's `⋯` "Suggest tags" row: `entryText` (a note section)
   * plus the vault tag vocabulary in, up to four suggested tags out.
   * `taskId` makes it cancellable. Rejects when LLM features are off or
   * the Tags plugin is disabled.
   */
  suggestTags(entryText: string, taskId?: string): Promise<string[]>;

  /**
   * The tag vocabulary + configured prefix styles from the section-search
   * provider (the tags plugin registers it). Resolves to empty arrays when
   * no provider is registered — features degrade, never throw.
   */
  searchVocabulary(): Promise<TagVocabularyPayload>;

  /**
   * Fires when the section-search provider or its index changed (index
   * rebuild, settings change, plugin enable/disable). Returns an
   * unsubscribe.
   */
  onSearchChanged(listener: () => void): () => void;
}
