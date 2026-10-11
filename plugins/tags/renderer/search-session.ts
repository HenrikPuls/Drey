/**
 * The Search panel's model: the query, the persisted choices, the hits of
 * the last run and the run itself. No DOM -- the panel, the replace flow
 * and the summary all read and change this one object and re-render
 * through `subscribe`.
 */
import type {
  DreyPluginApi,
  SectionSearchScope,
  TagSearchQuery,
} from '../../../shared/plugin-api/renderer';
import {
  buildTextMatcher,
  filterChatHits,
  runTagSearch,
  sectionCarriesTags,
} from '../shared/search.js';
import { sectionRecordsFor } from '../shared/section-records.js';
import { mergeOpenBufferHits, type PanelHit } from './hit-list.js';
import { loadPrefs, savePrefs, type SearchPrefs } from './search-prefs.js';

/** Files under here are kept out of the tag index (mirrors the main-side index). */
const TEMPLATES_PREFIX = 'templates/';

/** The SDK seam's hit budget (mirrors the assistant's DEFAULT_SEMANTIC_SEARCH_LIMIT). */
const SEMANTIC_LIMIT = 12;

export interface SearchState {
  queryTags: string[];
  queryText: string;
  replacement: string;
  hits: PanelHit[];
  searching: boolean;
  ran: boolean;
  /** Matcher / provider error, surfaced instead of a silent empty list. */
  error: string | null;
  /** The summarise flow's error (a failed generation), beside the search error. */
  summaryError: string | null;
}

export interface SearchSession {
  /** Mutable; call `persistPrefs()` after a change. */
  readonly prefs: SearchPrefs;
  /** Mutable; call `notify()` after a change. */
  readonly state: SearchState;
  /** File groups the user folded; a fresh result set starts unfolded. */
  readonly collapsedFiles: Set<string>;
  persistPrefs(): void;
  subscribe(listener: () => void): () => void;
  notify(): void;
  activeVaultId(): string | null;
  hasQuery(): boolean;
  /** Semantic mode: vault/all scope only — the renderer cannot embed a file-scope buffer. */
  semanticActive(): boolean;
  currentQuery(): TagSearchQuery;
  /** The focused document when it is a text tab, else null. */
  activeTextDoc(): ReturnType<DreyPluginApi['documents']['active']>;
  run(): Promise<void>;
  /** Empties the query and the results. */
  clear(): void;
}

export function createSearchSession(api: DreyPluginApi): SearchSession {
  const prefs = loadPrefs();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  // Hits of another vault are labelled with it, so a switch re-renders.
  let activeVaultId: string | null = null;
  const refreshVaults = (): void => {
    void api.vault
      .listVaults()
      .then((vaults) => {
        activeVaultId = vaults.find((v) => v.active)?.id ?? null;
        notify();
      })
      .catch(() => undefined);
  };
  refreshVaults();
  api.vault.onChanged(refreshVaults);

  const state: SearchState = {
    queryTags: [],
    queryText: '',
    replacement: '',
    hits: [],
    searching: false,
    ran: false,
    error: null,
    summaryError: null,
  };
  const hasQuery = (): boolean => state.queryTags.length > 0 || state.queryText.trim() !== '';
  const semanticActive = (): boolean => prefs.semantic && prefs.scope !== 'file';

  const currentQuery = (): TagSearchQuery => ({
    tags: state.queryTags,
    text: state.queryText.trim(),
    match: {
      caseSensitive: prefs.matchCase,
      wholeWord: prefs.wholeWord,
      regex: prefs.regex,
    },
  });

  const activeTextDoc = (): ReturnType<typeof api.documents.active> => {
    const doc = api.documents.active();
    return doc !== null && doc.kind === 'text' ? doc : null;
  };

  /** The open tabs whose unsaved text takes part in a vault / all search. */
  const dirtyDocs = (): ReturnType<typeof api.documents.list> =>
    api.documents
      .list()
      .filter(
        (d) =>
          d.kind === 'text' &&
          d.dirty &&
          d.vaultId !== null &&
          !d.path.startsWith(TEMPLATES_PREFIX) &&
          d.name !== 'search-results.md' &&
          // In vault scope a dirty tab of another vault is out of scope.
          (prefs.scope !== 'vault' || d.vaultId === activeVaultId),
      );

  /** Ends a run that cannot search: the reason shows instead of an empty list. */
  const refuse = (message: string): void => {
    state.error = message;
    state.hits = [];
    state.ran = true;
    notify();
  };

  const run = async (): Promise<void> => {
    if (!hasQuery()) {
      state.hits = [];
      state.ran = false;
      state.error = null;
      notify();
      return;
    }
    if (semanticActive()) {
      // Nothing to embed without text — tags alone cannot rank.
      if (state.queryText.trim() === '') {
        refuse('Type a question to search semantically.');
        return;
      }
    } else {
      const matcher = buildTextMatcher(currentQuery());
      if (!matcher.ok) {
        refuse(matcher.error);
        return;
      }
    }
    if (prefs.scope === 'file' && activeTextDoc() === null) {
      refuse('Open a text document to search the file scope.');
      return;
    }
    state.searching = true;
    state.error = null;
    notify();
    try {
      if (prefs.scope === 'file') {
        const doc = activeTextDoc();
        state.hits =
          doc === null
            ? []
            : runTagSearch(sectionRecordsFor(doc.path, doc.buffer), currentQuery()).map((h) => ({
                ...h,
                vaultId: doc.vaultId ?? undefined,
              }));
        state.ran = true;
      } else {
        const scope: SectionSearchScope | undefined =
          prefs.scope === 'all'
            ? { kind: 'all' }
            : activeVaultId !== null
              ? { kind: 'vault', vaultId: activeVaultId }
              : undefined;
        if (semanticActive()) {
          // Ranking over disk state: no dirty-buffer folding (the index
          // is disk-side), no chats toggle (the semantic index excludes
          // chat notes by design, ADR-0055). Tag chips stay meaningful
          // as an exact post-filter over the hydrated section text.
          const hits = await api.search.searchSemantic(
            state.queryText.trim(),
            scope,
            SEMANTIC_LIMIT,
          );
          state.hits = hits.filter((hit) =>
            sectionCarriesTags(hit.heading, hit.text, state.queryTags),
          );
        } else {
          const query = currentQuery();
          const diskHits = await api.search.searchSections(query, scope);
          // Chats stay indexed; the panel lists them only on request.
          state.hits = filterChatHits(
            mergeOpenBufferHits(diskHits, dirtyDocs(), query),
            prefs.includeChats,
          );
        }
        state.ran = true;
      }
    } catch (error) {
      // A rejected search (e.g. the tags backend is gone) is a message,
      // never a silent empty panel.
      const message = error instanceof Error ? error.message : String(error);
      state.error = message.includes('no semantic-search provider')
        ? "Semantic search is unavailable — the assistant's retrieval is disabled (Settings → Assistant retrieval)."
        : message;
      state.hits = [];
    } finally {
      state.searching = false;
      notify();
    }
  };

  return {
    prefs,
    state,
    collapsedFiles: new Set<string>(),
    persistPrefs: () => savePrefs(prefs),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify,
    activeVaultId: () => activeVaultId,
    hasQuery,
    semanticActive,
    currentQuery,
    activeTextDoc,
    run,
    clear: () => {
      state.queryTags = [];
      state.queryText = '';
      state.hits = [];
      state.ran = false;
      state.error = null;
      state.summaryError = null;
      notify();
    },
  };
}
