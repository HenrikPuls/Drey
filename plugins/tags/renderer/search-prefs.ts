/** The Search panel's persisted choices (`localStorage['drey.search']`). */

export const PREFS_KEY = 'drey.search';

export type Scope = 'file' | 'vault' | 'all';

export interface SearchPrefs {
  scope: Scope;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  replaceOpen: boolean;
  /** Vault / all scope: list hits from assistant chat notes (`chats/`) too. */
  includeChats: boolean;
  /** Vault / all scope: rank the text query semantically (SDK 1.18) instead of exact-matching it. */
  semantic: boolean;
}

export const DEFAULT_PREFS: SearchPrefs = {
  includeChats: false,
  scope: 'vault',
  matchCase: false,
  wholeWord: false,
  regex: false,
  replaceOpen: false,
  semantic: false,
};

/** Reads stored prefs; anything missing or malformed falls back to the default. */
export function parsePrefs(raw: string | null): SearchPrefs {
  if (raw === null) {
    return { ...DEFAULT_PREFS };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SearchPrefs>;
    const scope: Scope =
      parsed.scope === 'file' || parsed.scope === 'all' ? parsed.scope : DEFAULT_PREFS.scope;
    return {
      scope,
      matchCase: parsed.matchCase === true,
      wholeWord: parsed.wholeWord === true,
      regex: parsed.regex === true,
      replaceOpen: parsed.replaceOpen === true,
      includeChats: parsed.includeChats === true,
      semantic: parsed.semantic === true,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function loadPrefs(): SearchPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: SearchPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private-mode / quota: prefs just don't persist.
  }
}
