/**
 * The Search dock panel's DOM: the scope switch and mode toggles in the
 * header, ONE field for text and tags, the replace row, and the hits
 * grouped per file. Everything it shows comes from the `SearchSession`.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { formatSearchResultsDoc } from '../shared/search.js';
import { el, iconButton, toggleButton } from './dom.js';
import { groupHits } from './hit-list.js';
import type { Scope } from './search-prefs.js';
import type { SearchReplace } from './search-replace.js';
import type { SearchSession } from './search-session.js';
import type { SearchSummary } from './search-summary.js';

type WidgetContrib = Parameters<DreyPluginApi['ui']['registerWidget']>[0];
type TagField = ReturnType<DreyPluginApi['ui']['createTagField']>;

export interface SearchPanel {
  /** The dock widget to register. */
  readonly widget: WidgetContrib;
  /** Focuses the search field (once the dock has mounted the panel). */
  focus(): void;
  /** Empties the field's free text; the tag chips follow the session. */
  resetText(): void;
}

export function createSearchPanel(
  api: DreyPluginApi,
  session: SearchSession,
  summary: SearchSummary,
  replace: SearchReplace,
  clear: () => void,
): SearchPanel {
  const { prefs, state } = session;
  let searchField: TagField | null = null;

  const headerActions = (host: HTMLElement): (() => void) => {
    const seg = el('span', 'seg');
    seg.setAttribute('role', 'tablist');
    seg.setAttribute('aria-label', 'Search scope');
    const scopes: Array<[Scope, string, string]> = [
      ['file', 'file-text', 'Search the open document'],
      ['vault', 'folder', 'Search the active vault'],
      ['all', 'layers', 'Search every vault'],
    ];
    const buttons = scopes.map(([scope, icon, label]) => {
      const btn = iconButton(api, icon, label, () => {
        prefs.scope = scope;
        session.persistPrefs();
        session.notify();
      });
      btn.setAttribute('role', 'tab');
      btn.dataset['scope'] = scope;
      seg.appendChild(btn);
      return btn;
    });

    // Chat transcripts repeat the questions asked of them, so they stay
    // out of a vault search unless asked for. The file scope searches
    // the open document as it is — a focused chat note included.
    const chatsBtn = iconButton(api, 'message-circle', 'Include chats', () => {
      prefs.includeChats = !prefs.includeChats;
      session.persistPrefs();
      session.notify();
      void session.run();
    });

    // Semantic mode (SDK 1.18): rank the text query by similarity over
    // the assistant's vector index instead of exact-matching it. The
    // semantic index excludes chats on its own — the chats toggle has
    // no effect there and disables.
    const semanticBtn = iconButton(
      api,
      'brain',
      'Semantic search (rank by similarity instead of exact match)',
      () => {
        prefs.semantic = !prefs.semantic;
        session.persistPrefs();
        session.notify();
        void session.run();
      },
    );

    const render = (): void => {
      for (const btn of buttons) {
        const on = btn.dataset['scope'] === prefs.scope;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-selected', String(on));
      }
      chatsBtn.classList.toggle('on', prefs.includeChats);
      chatsBtn.setAttribute('aria-pressed', String(prefs.includeChats));
      chatsBtn.disabled = prefs.scope === 'file' || session.semanticActive();
      semanticBtn.classList.toggle('on', prefs.semantic);
      semanticBtn.setAttribute('aria-pressed', String(prefs.semantic));
      semanticBtn.disabled = prefs.scope === 'file';
    };
    render();
    const unsubscribe = session.subscribe(render);
    host.append(seg, semanticBtn, chatsBtn);
    return unsubscribe;
  };

  const mount = (body: HTMLElement): (() => void) => {
    body.classList.add('tag-search');

    // -- query block (pinned; only the results scroll — flush widget) --
    // ONE field for text and tags (milestone 43): a typed `#name` word
    // lifts out into a coloured chip, everything else is the text query.
    const field = el('div', 'tag-search-field');
    const fieldIcon = el('span', 'tag-search-field-icon');
    fieldIcon.appendChild(api.ui.icon('search', 14));
    const tagField = api.ui.createTagField({
      values: state.queryTags,
      onChange: (values) => {
        state.queryTags = values;
        session.notify();
        void session.run();
      },
      ariaLabel: 'Search text and #tags',
      freeText: {
        value: state.queryText,
        onInput: (text) => {
          state.queryText = text;
          session.notify();
        },
        onSubmit: () => void session.run(),
      },
    });
    searchField = tagField;

    const prefToggle = (
      label: string,
      title: string,
      key: 'matchCase' | 'wholeWord' | 'regex',
    ): HTMLButtonElement =>
      toggleButton(label, title, () => {
        prefs[key] = !prefs[key];
        session.persistPrefs();
        session.notify();
      });
    const caseBtn = prefToggle('Aa', 'Match case', 'matchCase');
    const wordBtn = prefToggle('ab', 'Whole word', 'wholeWord');
    const regexBtn = prefToggle('.*', 'Regular expression', 'regex');
    field.append(fieldIcon, tagField.element, caseBtn, wordBtn, regexBtn);

    const replaceRow = el('div', 'tag-search-field tag-search-replace');
    const replaceIcon = el('span', 'tag-search-field-icon');
    replaceIcon.appendChild(api.ui.icon('replace', 14));
    const replaceInput = el('input', 'tag-search-input') as HTMLInputElement;
    replaceInput.type = 'text';
    replaceInput.autocomplete = 'off';
    replaceInput.setAttribute('aria-label', 'Replace with');
    const replaceAllBtn = iconButton(api, 'check', 'Replace all', () => replace.replaceAll());
    replaceRow.append(replaceIcon, replaceInput, replaceAllBtn);

    const errorRow = el('p', 'tag-search-error');
    const resultsBox = el('div', 'tag-search-results');
    const summaryRow = el('div', 'tag-search-summary');
    const summaryText = el('span', 'tag-search-summary-text');
    const replaceBtn = iconButton(api, 'replace', 'Replace', () => {
      prefs.replaceOpen = !prefs.replaceOpen;
      session.persistPrefs();
      session.notify();
    });
    replaceBtn.setAttribute('aria-pressed', 'false');
    const exportButton = iconButton(api, 'download', 'Export results to a note', () => {
      const doc = formatSearchResultsDoc(
        { tags: state.queryTags, text: state.queryText },
        state.hits,
      );
      api.documents.openScratch('search-results.md', doc);
    });
    const summarizeButton = iconButton(api, 'sparkles', 'Summarize', () => {
      if (summary.isRunning()) {
        summary.cancel();
        return;
      }
      summary.start();
    });
    const clearButton = iconButton(api, 'x', 'Clear search', clear);
    summaryRow.append(summaryText, replaceBtn, exportButton, summarizeButton, clearButton);

    const renderToggles = (): void => {
      // Match flags are exact-match modifiers — meaningless on a ranking.
      const semantic = session.semanticActive();
      const noHits = state.hits.length === 0 || !state.ran;
      const flags: Array<[HTMLButtonElement, boolean]> = [
        [caseBtn, prefs.matchCase],
        [wordBtn, prefs.wholeWord],
        [regexBtn, prefs.regex],
      ];
      for (const [btn, on] of flags) {
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.disabled = semantic;
      }
      replaceBtn.classList.toggle('on', prefs.replaceOpen);
      replaceBtn.setAttribute('aria-pressed', String(prefs.replaceOpen));
      replaceBtn.hidden = semantic || (noHits && !prefs.replaceOpen);
      replaceRow.hidden = semantic || !prefs.replaceOpen;
    };

    const renderResults = (): void => {
      resultsBox.textContent = '';
      summaryRow.hidden = !state.ran;
      if (!state.ran) {
        errorRow.hidden = true;
        return;
      }
      const groups = groupHits(state.hits);
      summaryText.textContent =
        state.error !== null
          ? ''
          : `${state.hits.length} section${state.hits.length === 1 ? '' : 's'} in ${groups.length} file${groups.length === 1 ? '' : 's'}`;
      if (state.error !== null) {
        errorRow.textContent = state.error;
        errorRow.hidden = false;
        return;
      }
      if (state.summaryError !== null) {
        errorRow.textContent = state.summaryError;
        errorRow.hidden = false;
      } else {
        errorRow.hidden = true;
      }
      if (state.hits.length === 0) {
        resultsBox.appendChild(el('p', 'tag-search-empty', 'No matches.'));
        return;
      }
      for (const group of groups) {
        const details = el('details', 'tag-search-file');
        details.open = !session.collapsedFiles.has(group.key);
        details.addEventListener('toggle', () => {
          if (details.open) {
            session.collapsedFiles.delete(group.key);
          } else {
            session.collapsedFiles.add(group.key);
          }
        });
        const head = el('summary', 'tag-search-file-head');
        const chevron = el('span', 'tag-search-file-chevron');
        chevron.appendChild(api.ui.icon('chevron-right', 14));
        head.appendChild(chevron);
        const pathLabel = el('span', 'tag-search-file-path', group.path);
        pathLabel.title = group.path;
        head.appendChild(pathLabel);
        if (group.vaultId !== null && group.vaultId !== session.activeVaultId()) {
          head.appendChild(el('span', 'tag-search-file-vault', group.vaultId));
        }
        head.appendChild(el('span', 'tag-search-file-count', String(group.hits.length)));
        details.appendChild(head);

        for (const hit of group.hits) {
          const hitButton = el('button', 'tag-search-hit') as HTMLButtonElement;
          hitButton.type = 'button';
          const hitHead = el('span', 'tag-search-hit-head');
          hitHead.appendChild(el('span', 'tag-search-hit-heading', hit.heading));
          hitHead.appendChild(el('span', 'tag-search-hit-loc', `:${hit.line}`));
          if (hit.score !== undefined) {
            const score = el('span', 'tag-search-hit-score', `${Math.round(hit.score * 100)}%`);
            score.title = 'Similarity';
            hitHead.appendChild(score);
          }
          if (hit.unsaved === true) {
            hitHead.appendChild(el('span', 'tag-search-hit-unsaved', 'unsaved'));
          }
          hitButton.appendChild(hitHead);
          hitButton.appendChild(el('span', 'tag-search-hit-snippet', hit.snippet));
          hitButton.addEventListener('click', (event) => {
            if ((event.target as HTMLElement | null)?.closest('.tag-search-hit-replace') !== null) {
              return; // the inner button handles itself
            }
            void api.documents.open(hit.path, hit.line, { vaultId: hit.vaultId });
          });
          if (prefs.replaceOpen && !session.semanticActive()) {
            const replaceOne = el('button', 'icon-btn tag-search-hit-replace') as HTMLButtonElement;
            replaceOne.type = 'button';
            replaceOne.appendChild(api.ui.icon('replace', 14));
            replaceOne.title = 'Replace matches in this file';
            replaceOne.setAttribute('aria-label', `Replace matches in ${hit.path}`);
            replaceOne.addEventListener('click', (event) => {
              event.stopPropagation();
              replace.replaceInFile(hit);
            });
            hitButton.appendChild(replaceOne);
          }
          details.appendChild(hitButton);
        }
        resultsBox.appendChild(details);
      }
    };

    const setIcon = (btn: HTMLButtonElement, icon: string): void => {
      btn.textContent = '';
      btn.appendChild(api.ui.icon(icon, 14));
    };
    let shownSummarizing: boolean | null = null;

    const render = (): void => {
      renderToggles();
      tagField.setValues(state.queryTags);
      if (!field.contains(document.activeElement)) {
        tagField.setText(state.queryText);
      }
      replaceInput.value = state.replacement;
      replaceAllBtn.disabled =
        !session.hasQuery() ||
        (prefs.scope === 'file' && session.activeTextDoc() === null) ||
        session.semanticActive();
      const noHits = state.hits.length === 0 || !state.ran;
      exportButton.hidden = noHits;
      const summarizing = summary.isRunning();
      summarizeButton.hidden = !summarizing && (noHits || !api.llm.enabled());
      if (shownSummarizing !== summarizing) {
        shownSummarizing = summarizing;
        setIcon(summarizeButton, summarizing ? 'square' : 'sparkles');
      }
      const summarizeLabel = summarizing
        ? 'Stop summarizing'
        : api.llm.enabled()
          ? 'Summarize the search results with the connected LLM'
          : 'Connect an LLM in Settings → LLM to enable this';
      summarizeButton.title = summarizeLabel;
      summarizeButton.setAttribute('aria-label', summarizing ? 'Stop summarizing' : 'Summarize');
      summarizeButton.disabled = !summarizing && !api.llm.enabled();
      renderResults();
    };

    replaceInput.addEventListener('input', () => {
      state.replacement = replaceInput.value;
    });

    body.append(field, replaceRow, errorRow, summaryRow, resultsBox);
    render();
    const unsubscribe = session.subscribe(render);
    return () => {
      unsubscribe();
      tagField.dispose();
      searchField = null;
    };
  };

  return {
    widget: {
      id: 'search',
      title: 'Search',
      icon: 'search',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 260,
      flush: true,
      status: () => {
        if (summary.isRunning()) {
          return 'summarizing…';
        }
        return state.ran && state.error === null
          ? `${state.hits.length} hit${state.hits.length === 1 ? '' : 's'}`
          : null;
      },
      headerActions,
      mount,
    },
    focus: () => {
      // The dock may mount the widget lazily; a later tick reaches a fresh mount.
      window.setTimeout(() => searchField?.focus(), 0);
    },
    resetText: () => searchField?.setText(''),
  };
}
