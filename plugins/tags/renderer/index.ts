import type {
  DreyPluginApi,
  PluginRendererModule,
  TagEntry,
  TagSearchHit,
  TagSearchQuery,
} from '../../../shared/plugin-api/renderer';
import { formatSearchResultsDoc, runTagSearch } from '../shared/search.js';
import { sectionRecordsFor } from '../shared/section-records.js';
import { tagsExtension } from './extensions.js';

/** Files under here are kept out of the tag index (mirrors the main-side index). */
const TEMPLATES_PREFIX = 'templates/';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, label) as HTMLButtonElement;
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/**
 * The Tags plugin's renderer (ADR-0017, converted in ADR-0044 stage 5): the
 * Search dock panel, `#tag` autocomplete + pills as editor extensions, the
 * `search.open` command (Mod+Shift+F) and the pill-click reveal — ported
 * from `src/app/tags/` to plain DOM.
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    // -- search state ---------------------------------------------------------
    const state = {
      queryTags: [] as string[],
      queryText: '',
      hits: [] as TagSearchHit[],
      searching: false,
      ran: false,
    };
    let panelRerender: (() => void) | null = null;
    const listeners = new Set<() => void>();
    const notify = (): void => {
      for (const listener of [...listeners]) {
        listener();
      }
    };

    let vocabulary: TagEntry[] = [];
    const refreshVocabulary = (): void => {
      void api.backend
        .invoke('vocabulary')
        .then((v) => {
          vocabulary = (v as TagEntry[]) ?? [];
          notify();
        })
        .catch(() => undefined);
    };
    refreshVocabulary();
    api.vault.onChanged(refreshVocabulary);
    // The main-side index builds in the background now (activation no
    // longer waits for it) — this push is what populates the vocabulary
    // (and so #tag autocomplete) once the boot sweep finishes, even when
    // no vault-change event fired for it.
    api.backend.on('index-updated', refreshVocabulary);

    const addTag = (raw: string): void => {
      const tag = raw.trim().replace(/^#/, '').toLowerCase();
      if (tag === '' || state.queryTags.includes(tag)) {
        return;
      }
      state.queryTags = [...state.queryTags, tag];
      notify();
    };
    const removeTag = (tag: string): void => {
      state.queryTags = state.queryTags.filter((t) => t !== tag);
      notify();
    };
    const clear = (): void => {
      state.queryTags = [];
      state.queryText = '';
      state.hits = [];
      state.ran = false;
      notify();
    };
    const hasQuery = (): boolean => state.queryTags.length > 0 || state.queryText.trim() !== '';

    /** On-disk hits via the plugin main, folded with open tabs' unsaved buffers. */
    const run = async (): Promise<void> => {
      if (!hasQuery()) {
        state.hits = [];
        state.ran = false;
        notify();
        return;
      }
      state.searching = true;
      notify();
      const query: TagSearchQuery = { tags: state.queryTags, text: state.queryText.trim() };
      try {
        const diskHits = (await api.search.searchSections(query)) as TagSearchHit[];
        state.hits = withOpenBufferHits(diskHits, query);
        state.ran = true;
      } catch {
        state.hits = [];
      } finally {
        state.searching = false;
        notify();
      }
    };

    function withOpenBufferHits(
      diskHits: TagSearchHit[],
      query: TagSearchQuery,
    ): TagSearchHit[] {
      // A tab with unsaved edits (or a never-saved scratch tab) replaces its
      // own on-disk hits with what its current text matches — tagged
      // `unsaved`. Same routines the main-side index runs.
      const dirty = api.documents
        .list()
        .filter(
          (d) =>
            d.kind === 'text' &&
            d.dirty &&
            !d.path.startsWith(TEMPLATES_PREFIX) &&
            !(d.name === 'search-results.md'),
        );
      if (dirty.length === 0) {
        return diskHits;
      }
      const dirtyPaths = new Set(dirty.map((d) => d.path));
      const merged: TagSearchHit[] = diskHits.filter((h) => !dirtyPaths.has(h.path));
      for (const doc of dirty) {
        for (const hit of runTagSearch(sectionRecordsFor(doc.path, doc.buffer), query)) {
          merged.push({ ...hit, unsaved: true });
        }
      }
      merged.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      return merged;
    }

    // -- editor extensions: #tag completion + pills ---------------------------
    api.editor.registerExtension('both', (context) =>
      tagsExtension(
        api.editor.cm,
        () => vocabulary,
        (tag) => {
          // A pill click: reset the query to this tag, reveal + run.
          clear();
          addTag(tag);
          api.ui.revealWidget('search');
          notify();
          void run();
        },
        context,
      ),
    );

    // -- Mod+Shift+F (the command id the shell used to register) --------------
    api.commands.register({
      id: 'search.open',
      label: 'Search tags',
      keybinding: 'Mod+Shift+F',
      run: () => {
        api.ui.revealWidget('search');
        notify();
      },
    });

    // -- the Search dock panel -------------------------------------------------
    api.ui.registerWidget({
      id: 'search',
      title: 'Search',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 220,
      status: () => (state.ran && state.hits.length > 0 ? `${state.hits.length} hits` : null),
      mount: (body) => {
        body.classList.add('tag-search');
        const chipField = el('div', 'chip-field');
        const chipInput = el('input', 'chip-input') as HTMLInputElement;
        chipInput.type = 'text';
        chipInput.autocomplete = 'off';
        chipInput.placeholder = '+ tag';

        const textInput = el('input', 'text-input') as HTMLInputElement;
        textInput.type = 'text';
        textInput.autocomplete = 'off';
        textInput.placeholder = 'free text…';

        const actions = el('div', 'actions');
        const resultsBox = el('div', 'results-box');
        const clearButton = button('ghost', 'Clear', () => {
          clear();
        });
        const searchButton = button('primary', 'Search', () => void run());
        const exportButton = button('ghost', 'Export', () => {
          const doc = formatSearchResultsDoc(
            { tags: state.queryTags, text: state.queryText },
            state.hits,
          );
          api.documents.openScratch('search-results.md', doc);
        });

        const renderChips = (): void => {
          chipField.textContent = '';
          for (const tag of state.queryTags) {
            const chip = el('span', 'chip', `#${tag}`);
            const x = el('button', 'x', '×') as HTMLButtonElement;
            x.type = 'button';
            x.setAttribute('aria-label', `Remove ${tag}`);
            x.addEventListener('click', () => removeTag(tag));
            chip.appendChild(x);
            chipField.appendChild(chip);
          }
          chipField.appendChild(chipInput);
        };

        const renderResults = (): void => {
          resultsBox.textContent = '';
          if (!state.ran) {
            return;
          }
          const summaryRow = el('div', 'summary-row');
          summaryRow.appendChild(
            el(
              'p',
              'result-count',
              `${state.hits.length} ${state.hits.length === 1 ? 'section' : 'sections'}`,
            ),
          );
          if (state.hits.length > 0) {
            summaryRow.appendChild(exportButton);
          }
          resultsBox.appendChild(summaryRow);

          const list = el('ul', 'results');
          for (const hit of state.hits) {
            const item = el('li');
            const hitButton = button('hit', '', () => {
              void api.documents.open(hit.path, hit.line);
            });
            hitButton.appendChild(el('span', 'hit-heading', hit.heading));
            hitButton.appendChild(el('span', 'hit-path', hit.path));
            hitButton.appendChild(el('span', 'hit-snippet', hit.snippet));
            item.appendChild(hitButton);
            list.appendChild(item);
          }
          resultsBox.appendChild(list);
        };

        const render = (): void => {
          renderChips();
          textInput.value = state.queryText;
          actions.textContent = '';
          clearButton.disabled = !hasQuery();
          searchButton.disabled = !hasQuery() || state.searching;
          searchButton.textContent = state.searching ? 'Searching…' : 'Search';
          actions.appendChild(clearButton);
          actions.appendChild(searchButton);
          renderResults();
        };

        chipInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            if (chipInput.value.trim() !== '') {
              addTag(chipInput.value);
              chipInput.value = '';
            } else {
              void run();
            }
            return;
          }
          if (event.key === 'Backspace' && chipInput.value === '' && state.queryTags.length > 0) {
            removeTag(state.queryTags[state.queryTags.length - 1]);
          }
        });
        chipInput.addEventListener('blur', () => {
          if (chipInput.value.trim() !== '') {
            addTag(chipInput.value);
            chipInput.value = '';
          }
        });
        textInput.addEventListener('input', () => {
          state.queryText = textInput.value;
          notify();
        });
        textInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            void run();
          }
        });

        body.appendChild(chipField);
        body.appendChild(textInput);
        body.appendChild(actions);
        body.appendChild(resultsBox);
        render();
        listeners.add(render);
        return () => {
          listeners.delete(render);
        };
      },
    });

    // The widget's mount registers its render into `listeners`; every state
    // mutation funnels through `notify`.
  },
};

export default plugin;
