/**
 * IPC contract, spellcheck part (ADR-0013, ADR-0056)
 * (`shared/ipc-api.ts` is the barrel).
 */
import type { AppConfig, CustomDictionary } from '../app-config';

/**
 * One dictionary the spellchecker can be switched to -- the bundled
 * languages plus whatever the user added (`CustomDictionary`). `loaded`
 * says whether the dictionary files were actually readable, so the
 * settings pane can show a broken custom entry as broken instead of
 * silently checking nothing.
 */
export interface SpellLanguage {
  id: string;
  label: string;
  builtin: boolean;
  loaded: boolean;
  /** Why it failed to load, when `loaded` is false. */
  error?: string;
}

/**
 * Result of one `spell:check` round: only the words the dictionary rejects.
 * Suggestions are deliberately absent -- generating them is expensive
 * (tens of milliseconds per word), so they are fetched per word through
 * `spell:suggest` when the user actually clicks a flagged word.
 */
export interface SpellCheckResult {
  /** The dictionary that produced this verdict (`''` when spellcheck is off). */
  language: string;
  misspelled: string[];
}

/** Checking words, suggestions and dictionaries. */
export interface SpellingIpc {
  /**
   * Checks `words` against the given dictionary and returns only the ones
   * it rejects. `language` selects the dictionary explicitly (the
   * per-paragraph auto-detect path, ADR-0056); without it the configured
   * active dictionary is used. Never rejects: spellcheck being off or a
   * dictionary failing to load yields an empty list, because a broken
   * checker must not break typing. Deliberately carries no suggestions --
   * the suggestion search is the expensive part, so it is fetched per word
   * via `suggestSpelling` when a flagged word's popup opens.
   */
  checkSpelling(words: string[], language?: string): Promise<SpellCheckResult>;

  /**
   * Suggestions for one misspelled word (up to a handful), fetched when
   * the user opens its popup -- never during the bulk check. `language`
   * selects the dictionary the word was flagged under (ADR-0056); without
   * it the configured active dictionary is used. Returns `[]` for an
   * accepted word (it may have been added since it was flagged) or when
   * no dictionary is available.
   */
  suggestSpelling(word: string, language?: string): Promise<string[]>;

  /** Every dictionary that can be selected, bundled and custom. */
  listSpellLanguages(): Promise<SpellLanguage[]>;

  /**
   * Opens a file picker for a Hunspell `.dic` (its `.aff` sibling is taken
   * from the same folder) and returns the config entry to store, or `null`
   * when the user cancelled or the pair is incomplete.
   */
  addSpellDictionary(): Promise<CustomDictionary | null>;

  /**
   * Adds `word` to the spellchecker's accepted words -- to the given
   * dictionary's list (`target: 'language'`, defaulting to the configured
   * active one -- the auto-detect path passes the language the word was
   * flagged under) or the global personal list (`target: 'personal'`) --
   * persists it, and reloads the checker so the squiggle clears
   * immediately (no Settings round-trip). Returns the stored config so an
   * open Settings screen can reconcile.
   */
  addSpellWord(word: string, target: 'language' | 'personal', language?: string): Promise<AppConfig>;
}
