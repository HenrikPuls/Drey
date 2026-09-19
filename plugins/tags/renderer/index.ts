import type {
  DreyPluginApi,
  PluginRendererModule,
  SectionSearchScope,
  TagEntry,
  TagSearchHit,
  TagSearchQuery,
} from '../../../shared/plugin-api/renderer';
import {
  buildTextMatcher,
  formatSearchResultsDoc,
  patchContent,
  runTagSearch,
} from '../shared/search.js';
import { sectionRecordsFor } from '../shared/section-records.js';
import { registerTagsSettingsPage } from './settings.js';

/** Files under here are kept out of the tag index (mirrors the main-side index). */
const TEMPLATES_PREFIX = 'templates/';

const PREFS_KEY = 'drey.search';

type Scope = 'file' | 'vault' | 'all';

interface SearchPrefs {
  scope: Scope;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  replaceOpen: boolean;
}

const DEFAULT_PREFS: SearchPrefs = {
  scope: 'vault',
  matchCase: false,
  wholeWord: false,
  regex: false,
  replaceOpen: false,
};

function loadPrefs(): SearchPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw === null) {
      return { ...DEFAULT_PREFS };
    }
    const parsed = JSON.parse(raw) as Partial<SearchPrefs>;
    const scope: Scope =
      parsed.scope === 'file' || parsed.scope === 'all' ? parsed.scope : DEFAULT_PREFS.scope;
    return {
      scope,
      matchCase: parsed.matchCase === true,
      wholeWord: parsed.wholeWord === true,
      regex: parsed.regex === true,
      replaceOpen: parsed.replaceOpen === true,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

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

function toggleButton(
  className: string,
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const node = button(className, label, onClick);
  node.title = title;
  node.setAttribute('aria-pressed', 'false');
  return node;
}

/**
 * The Tags plugin's renderer: the redesigned Search dock panel (scopes
 * file/vault/all, match-case / whole-word / regex toggles, a replace row
 * with a bundled per-file confirmation, tag chips through the shared tag
 * field, results grouped per file) plus the `search.open` command
 * (Mod+Shift+F, focus + the `{ tag }` payload base tag pills send) and the
 * Settings → Tags page (prefix colors). Milestone 33; tag completion and
 * the pills themselves live in base now.
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    registerTagsSettingsPage(api);

    const prefs = loadPrefs();
    const persistPrefs = (): void => {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // Private-mode / quota: prefs just don't persist.
      }
    };
    let activeVaultId: string | null = null;
    const refreshVaults = (): void => {
      void api.vault
        .listVaults()
        .then((vaults) => {
          activeVaultId = vaults.find((v) => v.active)?.id ?? null;
        })
        .catch(() => undefined);
    };
    refreshVaults();

    // -- search state ---------------------------------------------------------
    const state = {
      queryTags: [] as string[],
      queryText: '',
      replacement: '',
      hits: [] as TagSearchHit[],
      searching: false,
      ran: false,
      /** Matcher / provider error, surfaced instead of a silent empty list. */
      error: null as string | null,
    };
    /** File groups the user folded; a fresh result set starts unfolded. */
    const collapsedFiles = new Set<string>();
    const listeners = new Set<() => void>();
    const notify = (): void => {
      for (const listener of [...listeners]) {
        listener();
      }
    };

    let vocabulary: TagEntry[] = [];
    const refreshVocabulary = (): void => {
      void api.search
        .vocabulary()
        .then((v) => {
          vocabulary = [...v];
          notify();
        })
        .catch(() => undefined);
    };
    refreshVocabulary();
    api.vault.onChanged(() => {
      refreshVaults();
      refreshVocabulary();
    });
    api.backend.on('index-updated', refreshVocabulary);

    const hasQuery = (): boolean => state.queryTags.length > 0 || state.queryText.trim() !== '';

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

    const clear = (): void => {
      state.queryTags = [];
      state.queryText = '';
      state.hits = [];
      state.ran = false;
      state.error = null;
      notify();
    };

    /** On-disk hits, folded with open tabs' unsaved buffers (vault-aware). */
    function withOpenBufferHits(
      diskHits: readonly TagSearchHit[],
      query: TagSearchQuery,
    ): TagSearchHit[] {
      const dirty = api.documents
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
      if (dirty.length === 0) {
        return [...diskHits];
      }
      const dirtyKeys = new Set(dirty.map((d) => `${d.vaultId} ${d.path}`));
      const merged: TagSearchHit[] = diskHits.filter(
        (h) => h.vaultId === undefined || !dirtyKeys.has(`${h.vaultId} ${h.path}`),
      );
      for (const doc of dirty) {
        for (const hit of runTagSearch(sectionRecordsFor(doc.path, doc.buffer), query)) {
          merged.push({ ...hit, unsaved: true, vaultId: doc.vaultId ?? undefined });
        }
      }
      merged.sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          (a.vaultId ?? '').localeCompare(b.vaultId ?? '') ||
          a.line - b.line,
      );
      return merged;
    }

    const run = async (): Promise<void> => {
      if (!hasQuery()) {
        state.hits = [];
        state.ran = false;
        state.error = null;
        notify();
        return;
      }
      const query = currentQuery();
      const matcher = buildTextMatcher(query);
      if (!matcher.ok) {
        state.error = matcher.error;
        state.hits = [];
        state.ran = true;
        notify();
        return;
      }
      if (prefs.scope === 'file' && activeTextDoc() === null) {
        state.error = 'Open a text document to search the file scope.';
        state.hits = [];
        state.ran = true;
        notify();
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
              : runTagSearch(sectionRecordsFor(doc.path, doc.buffer), query).map((h) => ({
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
          const diskHits = await api.search.searchSections(query, scope);
          state.hits = withOpenBufferHits(diskHits, query);
          state.ran = true;
        }
      } catch (error) {
        // A rejected search (e.g. the tags backend is gone) is a message,
        // never a silent empty panel.
        state.error = error instanceof Error ? error.message : String(error);
        state.hits = [];
      } finally {
        state.searching = false;
        notify();
      }
    };

    // -- replace ---------------------------------------------------------------

    const applyReplaceInFileScope = (): void => {
      const doc = activeTextDoc();
      if (doc === null) {
        return;
      }
      // The buffer is the working copy: this stays an unsaved, undoable edit.
      const patch = patchContent(doc.buffer, currentQuery(), state.replacement);
      if (patch === null || patch.after === patch.before) {
        return;
      }
      api.documents.setBuffer(doc.path, patch.after);
      void run();
    };

    const showReplaceConfirmation = (ops: ReplaceOp[], onDone: () => void): void => {
      const totalOccurrences = ops.reduce((n, op) => n + op.occurrences, 0);
      // `showModal` returns the programmatic close — the Cancel/Apply
      // closures below close over it.
      let close = (): void => {};
      close = api.ui.showModal((box) => {
        box.classList.add('tag-search-modal');
        box.appendChild(
          el(
            'h3',
            'tag-search-modal-title',
            `Replace ${totalOccurrences} occurrence${totalOccurrences === 1 ? '' : 's'} in ${ops.length} file${ops.length === 1 ? '' : 's'}?`,
          ),
        );
        box.appendChild(
          el(
            'p',
            'tag-search-modal-hint',
            'Only text inside the matching sections changes. Each file is re-checked right before it is written.',
          ),
        );
        for (const op of ops) {
          const details = el('details', 'tag-search-modal-file');
          const summary = el('summary', 'tag-search-modal-file-head');
          const foreign = prefs.scope === 'all' && op.vaultId !== activeVaultId;
          summary.appendChild(el('span', 'tag-search-modal-path', op.path));
          if (foreign) {
            summary.appendChild(el('span', 'tag-search-modal-vault', op.vaultId));
          }
          summary.appendChild(el('span', 'tag-search-modal-count', `${op.occurrences} ×`));
          details.appendChild(summary);
          const diff = el('div', 'tag-search-modal-diff');
          for (const row of op.diff) {
            if (row.type === 'context') {
              continue; // collapsed to the changed lines by default
            }
            const line = el(
              'span',
              row.type === 'add' ? 'tag-search-diff-add' : 'tag-search-diff-del',
              `${row.type === 'add' ? '+' : '−'} ${row.text}`,
            );
            diff.appendChild(line);
          }
          if (diff.childElementCount === 0) {
            diff.appendChild(el('span', 'tag-search-modal-empty', '(no line changes)'));
          }
          details.appendChild(diff);
          box.appendChild(details);
        }
        const row = el('div', 'tag-search-modal-actions');
        row.appendChild(
          button('ghost', 'Cancel', () => {
            close();
          }),
        );
        const apply = button('primary', 'Replace all', () => {
          void (async () => {
            apply.disabled = true;
            try {
              const result = (await api.backend.invoke('replace-apply', {
                query: currentQuery(),
                replacement: state.replacement,
                scope: prefs.scope === 'all' ? { kind: 'all' } : undefined,
              })) as { error?: string };
              if (result?.error !== undefined) {
                state.error = result.error;
              }
            } catch (error) {
              state.error = error instanceof Error ? error.message : String(error);
            }
            close();
            onDone();
          })();
        });
        row.appendChild(apply);
        box.appendChild(row);
      });
    };

    const replaceAllInVaultScope = async (): Promise<void> => {
      try {
        const preview = (await api.backend.invoke('replace-preview', {
          query: currentQuery(),
          replacement: state.replacement,
          scope: prefs.scope === 'all' ? { kind: 'all' } : undefined,
        })) as ReplacePreview;
        if (!preview.ok || preview.ops === undefined) {
          state.error = preview.error ?? 'Replace preview failed.';
          notify();
          return;
        }
        if (preview.ops.length === 0) {
          return;
        }
        showReplaceConfirmation(preview.ops, () => void run());
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
        notify();
      }
    };

    const replaceInFile = (hit: TagSearchHit): void => {
      if (prefs.scope === 'file') {
        applyReplaceInFileScope();
        return;
      }
      // Vault/all: one file's bundled confirmation (fresh patch, TOCTOU-safe).
      void (async () => {
        try {
          const preview = (await api.backend.invoke('replace-preview', {
            query: currentQuery(),
            replacement: state.replacement,
            files: [{ vaultId: hit.vaultId, path: hit.path }],
          })) as ReplacePreview;
          if (!preview.ok || preview.ops === undefined) {
            state.error = preview.error ?? 'Replace preview failed.';
            notify();
            return;
          }
          if (preview.ops.length === 0) {
            return;
          }
          showReplaceConfirmation(preview.ops, () => void run());
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
          notify();
        }
      })();
    };

    // -- search.open: Mod+Shift+F, focus + the pills' `{ tag }` payload -------

    let searchInput: HTMLInputElement | null = null;
    const focusSearch = (): void => {
      // The dock may mount the widget lazily; a later tick reaches a fresh mount.
      window.setTimeout(() => searchInput?.focus(), 0);
    };
    api.commands.register({
      id: 'search.open',
      label: 'Search all notes',
      keybinding: 'Mod+Shift+F',
      run: (payload) => {
        const tag = (payload as { tag?: unknown } | undefined)?.tag;
        if (typeof tag === 'string' && tag !== '') {
          // A base tag pill click: reset the query to this tag, reveal + run.
          clear();
          state.queryTags = [tag.toLowerCase().replace(/^#/, '')];
        }
        api.ui.revealWidget('search');
        notify();
        if (typeof tag === 'string' && tag !== '') {
          void run();
        }
        focusSearch();
      },
    });

    // -- the Search dock panel --------------------------------------------------

    api.ui.registerWidget({
      id: 'search',
      title: 'Search',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 260,
      flush: true,
      status: () =>
        state.ran && state.error === null
          ? `${state.hits.length} hit${state.hits.length === 1 ? '' : 's'}`
          : null,
      headerActions: (host) => {
        const row = el('div', 'tag-search-hdr');
        const seg = el('span', 'seg');
        seg.setAttribute('role', 'tablist');
        seg.setAttribute('aria-label', 'Search scope');
        const fileBtn = toggleButton('', 'File', 'Search the open document', () => {
          prefs.scope = 'file';
          persistPrefs();
          notify();
        });
        const vaultBtn = toggleButton('', 'Vault', 'Search the active vault', () => {
          prefs.scope = 'vault';
          persistPrefs();
          notify();
        });
        const allBtn = toggleButton('', 'All', 'Search every vault', () => {
          prefs.scope = 'all';
          persistPrefs();
          notify();
        });
        for (const btn of [fileBtn, vaultBtn, allBtn]) {
          btn.setAttribute('role', 'tab');
        }
        seg.append(fileBtn, vaultBtn, allBtn);
        row.appendChild(seg);

        const render = (): void => {
          fileBtn.classList.toggle('on', prefs.scope === 'file');
          fileBtn.setAttribute('aria-selected', String(prefs.scope === 'file'));
          vaultBtn.classList.toggle('on', prefs.scope === 'vault');
          vaultBtn.setAttribute('aria-selected', String(prefs.scope === 'vault'));
          allBtn.classList.toggle('on', prefs.scope === 'all');
          allBtn.setAttribute('aria-selected', String(prefs.scope === 'all'));
        };
        render();
        listeners.add(render);
        host.appendChild(row);
        return () => {
          listeners.delete(render);
        };
      },
      mount: (body) => {
        body.classList.add('tag-search');

        // -- query block (pinned; only the results scroll — flush widget) --
        const inputRow = el('div', 'tag-search-inputrow');
        const textInput = el('input', 'tag-search-input') as HTMLInputElement;
        textInput.type = 'text';
        textInput.autocomplete = 'off';
        textInput.placeholder = 'Search';
        textInput.setAttribute('aria-label', 'Search text');
        searchInput = textInput;

        const caseBtn = toggleButton('tag-search-tgl', 'Aa', 'Match case', () => {
          prefs.matchCase = !prefs.matchCase;
          persistPrefs();
          notify();
        });
        const wordBtn = toggleButton('tag-search-tgl', 'ab', 'Whole word', () => {
          prefs.wholeWord = !prefs.wholeWord;
          persistPrefs();
          notify();
        });
        const regexBtn = toggleButton('tag-search-tgl', '.*', 'Regular expression', () => {
          prefs.regex = !prefs.regex;
          persistPrefs();
          notify();
        });
        const replaceBtn = toggleButton(
          'tag-search-tgl',
          '⇄',
          'Toggle replace row',
          () => {
            prefs.replaceOpen = !prefs.replaceOpen;
            persistPrefs();
            notify();
          },
        );

        const replaceRow = el('div', 'tag-search-replace');
        const replaceInput = el('input', 'tag-search-input') as HTMLInputElement;
        replaceInput.type = 'text';
        replaceInput.autocomplete = 'off';
        replaceInput.placeholder = 'Replace';
        replaceInput.setAttribute('aria-label', 'Replace with');
        const replaceAllBtn = button('primary', 'Replace all', () => {
          if (prefs.scope === 'file') {
            applyReplaceInFileScope();
          } else {
            void replaceAllInVaultScope();
          }
        });
        replaceRow.append(replaceInput, replaceAllBtn);

        inputRow.append(textInput, caseBtn, wordBtn, regexBtn, replaceBtn);

        // The shared tag chip field: colored chips + completion dropdown.
        const tagField = api.ui.createTagField({
          values: state.queryTags,
          onChange: (values) => {
            state.queryTags = values;
            notify();
          },
          placeholder: '+ tag',
          ariaLabel: 'Tag filter',
        });

        const errorRow = el('p', 'tag-search-error');
        const resultsBox = el('div', 'tag-search-results');
        const summaryRow = el('div', 'tag-search-summary');
        const summaryText = el('span', 'tag-search-summary-text');
        const clearButton = button('ghost', 'Clear', () => {
          clear();
        });
        const exportButton = button('ghost', 'Export', () => {
          const doc = formatSearchResultsDoc(
            { tags: state.queryTags, text: state.queryText },
            state.hits,
          );
          api.documents.openScratch('search-results.md', doc);
        });
        summaryRow.append(summaryText, exportButton, clearButton);

        const renderToggles = (): void => {
          caseBtn.classList.toggle('on', prefs.matchCase);
          caseBtn.setAttribute('aria-pressed', String(prefs.matchCase));
          wordBtn.classList.toggle('on', prefs.wholeWord);
          wordBtn.setAttribute('aria-pressed', String(prefs.wholeWord));
          regexBtn.classList.toggle('on', prefs.regex);
          regexBtn.setAttribute('aria-pressed', String(prefs.regex));
          replaceBtn.classList.toggle('on', prefs.replaceOpen);
          replaceBtn.setAttribute('aria-pressed', String(prefs.replaceOpen));
          replaceRow.hidden = !prefs.replaceOpen;
        };

        const groupHits = (): Array<{ key: string; path: string; vaultId: string | null; hits: TagSearchHit[] }> => {
          const groups = new Map<string, { path: string; vaultId: string | null; hits: TagSearchHit[] }>();
          for (const hit of state.hits) {
            const key = `${hit.vaultId ?? ''} ${hit.path}`;
            let group = groups.get(key);
            if (group === undefined) {
              group = { path: hit.path, vaultId: hit.vaultId ?? null, hits: [] };
              groups.set(key, group);
            }
            group.hits.push(hit);
          }
          return [...groups.entries()]
            .map(([key, group]) => ({ key, ...group }))
            .sort((a, b) => a.path.localeCompare(b.path) || (a.key < b.key ? -1 : 1));
        };

        const renderResults = (): void => {
          resultsBox.textContent = '';
          summaryRow.hidden = !state.ran;
          if (!state.ran) {
            return;
          }
          const files = new Set(groupHits().map((g) => g.key));
          summaryText.textContent =
            state.error !== null
              ? ''
              : `${state.hits.length} match${state.hits.length === 1 ? '' : 'es'} · ${files.size} file${files.size === 1 ? '' : 's'}`;
          if (state.error !== null) {
            errorRow.textContent = state.error;
            errorRow.hidden = false;
            return;
          }
          errorRow.hidden = true;
          if (state.hits.length === 0) {
            resultsBox.appendChild(el('p', 'tag-search-empty', 'No matches.'));
            return;
          }
          for (const group of groupHits()) {
            const details = el('details', 'tag-search-file');
            details.open = !collapsedFiles.has(group.key);
            details.addEventListener('toggle', () => {
              if (details.open) {
                collapsedFiles.delete(group.key);
              } else {
                collapsedFiles.add(group.key);
              }
            });
            const summary = el('summary', 'tag-search-file-head');
            summary.appendChild(el('span', 'tag-search-file-path', group.path));
            if (group.vaultId !== null && group.vaultId !== activeVaultId) {
              summary.appendChild(el('span', 'tag-search-file-vault', group.vaultId));
            }
            summary.appendChild(el('span', 'tag-search-file-count', String(group.hits.length)));
            details.appendChild(summary);

            for (const hit of group.hits) {
              const hitButton = el('button', 'tag-search-hit') as HTMLButtonElement;
              hitButton.type = 'button';
              const head = el('span', 'tag-search-hit-head');
              head.appendChild(el('span', 'tag-search-hit-heading', hit.heading));
              head.appendChild(el('span', 'tag-search-hit-loc', `:${hit.line}`));
              if (hit.unsaved === true) {
                head.appendChild(el('span', 'tag-search-hit-unsaved', 'unsaved'));
              }
              hitButton.appendChild(head);
              hitButton.appendChild(el('span', 'tag-search-hit-snippet', hit.snippet));
              hitButton.addEventListener('click', (event) => {
                if ((event.target as HTMLElement | null)?.closest('.tag-search-hit-replace') !== null) {
                  return; // the inner button handles itself
                }
                void api.documents.open(hit.path, hit.line, { vaultId: hit.vaultId });
              });
              const replaceOne = el('button', 'tag-search-hit-replace', '⇄') as HTMLButtonElement;
              replaceOne.type = 'button';
              replaceOne.title = `Replace matches in this file`;
              replaceOne.setAttribute('aria-label', `Replace matches in ${hit.path}`);
              replaceOne.addEventListener('click', (event) => {
                event.stopPropagation();
                replaceInFile(hit);
              });
              hitButton.appendChild(replaceOne);
              details.appendChild(hitButton);
            }
            resultsBox.appendChild(details);
          }
        };

        const render = (): void => {
          renderToggles();
          if (document.activeElement !== textInput) {
            textInput.value = state.queryText;
          }
          replaceInput.value = state.replacement;
          replaceAllBtn.disabled = !hasQuery() || prefs.scope === 'file' && activeTextDoc() === null;
          clearButton.disabled = !hasQuery();
          exportButton.hidden = state.hits.length === 0 || !state.ran;
          renderResults();
        };

        textInput.addEventListener('input', () => {
          state.queryText = textInput.value;
          notify();
        });
        textInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            void run();
          }
        });
        replaceInput.addEventListener('input', () => {
          state.replacement = replaceInput.value;
        });

        body.append(inputRow, replaceRow, tagField.element, errorRow, summaryRow, resultsBox);
        render();
        listeners.add(render);
        return () => {
          listeners.delete(render);
          searchInput = null;
        };
      },
    });
  },
};

interface ReplaceOp {
  vaultId: string;
  path: string;
  occurrences: number;
  sections: number;
  added: number;
  removed: number;
  diff: Array<{ type: 'context' | 'add' | 'del'; text: string }>;
}

interface ReplacePreview {
  ok: boolean;
  ops?: ReplaceOp[];
  error?: string;
}

export default plugin;
