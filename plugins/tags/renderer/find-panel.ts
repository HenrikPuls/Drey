// i18n: catalog
/**
 * The Find dock panel (req-161, board 9c): one panel for Search and every
 * mode other plugins register (Tasks). The header carries the mode as its
 * title and one `⋯` menu; below it ONE field (the shared tag field, a Clear
 * and, in Search mode, the Replace switch) over the list of the active mode.
 * The Search mode is drawn here; any other mode mounts its own list through
 * the find-mode registry (SDK 1.54) and keeps its data.
 */
import type {
  DreyPluginApi,
  FindModeContrib,
  FindModeHandle,
  FindQuery,
} from '../../../shared/plugin-api/renderer';
import { formatSearchResultsDoc } from '../shared/search.js';
import { el, iconButton } from './dom.js';
import { openFindMenu, type FindMenuRow } from './find-menu.js';
import { groupHits, snippetParts, splitPath } from './hit-list.js';
import type { Scope } from './search-prefs.js';
import type { SearchReplace } from './search-replace.js';
import type { SearchSession } from './search-session.js';
import type { SearchSummary } from './search-summary.js';

type WidgetContrib = Parameters<DreyPluginApi['ui']['registerWidget']>[0];
type TagField = ReturnType<DreyPluginApi['ui']['createTagField']>;

/** The Search mode's id; every other mode comes from the registry. */
export const SEARCH_MODE = 'search';
const MODE_KEY = 'drey.find.mode';

export interface FindPanel {
  /** The dock widget to register. */
  readonly widget: WidgetContrib;
  /** Focuses the field (once the dock has mounted the panel). */
  focus(): void;
  /** Empties the field's free text; the tag chips follow the session. */
  resetText(): void;
  /** Switches the panel to a mode (`search` or a registered mode id). */
  showMode(id: string): void;
}

function loadMode(): string {
  try {
    return localStorage.getItem(MODE_KEY) ?? SEARCH_MODE;
  } catch {
    return SEARCH_MODE;
  }
}

export function createFindPanel(
  api: DreyPluginApi,
  session: SearchSession,
  summary: SearchSummary,
  replace: SearchReplace,
  clear: () => void,
): FindPanel {
  const { prefs, state } = session;
  const t = api.i18n.t;
  let field: TagField | null = null;
  let storedMode = loadMode();
  const modeListeners = new Set<() => void>();

  // -- modes ---------------------------------------------------------------
  const registered = (): readonly FindModeContrib[] => api.ui.findModes();
  /** The active mode id; a stored mode whose plugin is gone falls back to Search. */
  const currentMode = (): string =>
    storedMode === SEARCH_MODE || registered().some((m) => m.id === storedMode)
      ? storedMode
      : SEARCH_MODE;
  const activeContrib = (): FindModeContrib | null =>
    registered().find((m) => m.id === currentMode()) ?? null;
  const showMode = (id: string): void => {
    if (id === storedMode) {
      return;
    }
    storedMode = id;
    try {
      localStorage.setItem(MODE_KEY, id);
    } catch {
      // Private-mode: the mode just does not persist.
    }
    for (const listener of [...modeListeners]) {
      listener();
    }
    session.notify();
  };
  const query = (): FindQuery => ({
    tags: [...state.queryTags],
    text: state.queryText,
    scope: prefs.scope,
  });

  // -- header: the mode as the title, the status, ⋯ -------------------------
  const headerTitle = (host: HTMLElement): (() => void) => {
    const list = el('div', 'find-tabs');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', t('find.mode.aria'));
    const render = (): void => {
      list.textContent = '';
      const modes = [
        { id: SEARCH_MODE, label: t('find.mode.search') },
        ...registered().map((m) => ({ id: m.id, label: m.label })),
      ];
      for (const mode of modes) {
        const tab = el('button', 'find-tab', mode.label) as HTMLButtonElement;
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(mode.id === currentMode()));
        tab.addEventListener('click', () => showMode(mode.id));
        list.appendChild(tab);
      }
    };
    render();
    modeListeners.add(render);
    const off = api.ui.onFindModesChange(render);
    host.appendChild(list);
    return () => {
      modeListeners.delete(render);
      off();
      list.remove();
    };
  };

  const buildMenu = (): FindMenuRow[] => {
    const lookIn = (scope: Scope, label: string): FindMenuRow => ({
      kind: 'check',
      label,
      checked: prefs.scope === scope,
      run: () => {
        prefs.scope = scope;
        session.persistPrefs();
        session.notify();
        if (currentMode() === SEARCH_MODE && session.hasQuery()) {
          void session.run();
        }
      },
    });
    const rows: FindMenuRow[] = [
      { kind: 'label', label: t('find.menu.look_in') },
      lookIn('file', t('find.scope.file')),
      lookIn('vault', t('find.scope.vault')),
      lookIn('all', t('find.scope.all')),
      { kind: 'separator' },
    ];
    const contrib = activeContrib();
    if (contrib !== null) {
      return [...rows, ...contrib.menu(query())];
    }
    const flag = (key: 'matchCase' | 'wholeWord' | 'regex' | 'includeChats', label: string): FindMenuRow => ({
      kind: 'check',
      label,
      checked: prefs[key],
      run: () => {
        prefs[key] = !prefs[key];
        session.persistPrefs();
        session.notify();
        if (key === 'includeChats' && session.hasQuery()) {
          void session.run();
        }
      },
    });
    const noHits = state.hits.length === 0 || !state.ran;
    const summarizing = summary.isRunning();
    return [
      ...rows,
      flag('matchCase', t('find.menu.match_case')),
      flag('wholeWord', t('find.menu.whole_word')),
      flag('regex', t('find.menu.regex')),
      flag('includeChats', t('find.menu.include_chats')),
      { kind: 'separator' },
      {
        kind: 'item',
        label: t('find.menu.export'),
        disabled: noHits,
        run: () =>
          api.documents.openScratch(
            'search-results.md',
            formatSearchResultsDoc({ tags: state.queryTags, text: state.queryText }, state.hits),
          ),
      },
      {
        kind: 'item',
        label: summarizing ? t('find.menu.summarize_stop') : t('find.menu.summarize'),
        disabled: !summarizing && (noHits || !api.llm.enabled()),
        ...(api.llm.enabled() ? {} : { title: t('find.menu.summarize_off') }),
        run: () => (summarizing ? summary.cancel() : summary.start()),
      },
    ];
  };

  const headerActions = (host: HTMLElement): (() => void) => {
    const more = el('button', 'icon-btn') as HTMLButtonElement;
    more.type = 'button';
    more.appendChild(api.ui.icon('more-horizontal', 14));
    more.title = t('find.more');
    more.setAttribute('aria-label', t('find.more'));
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    let close: (() => void) | null = null;
    more.addEventListener('click', () => {
      if (close !== null) {
        close();
        return;
      }
      close = openFindMenu(api, more, buildMenu(), () => {
        close = null;
      });
    });
    host.appendChild(more);
    return () => {
      close?.();
      more.remove();
    };
  };

  const status = (): string | null => {
    const contrib = activeContrib();
    if (contrib !== null) {
      return contrib.status(query());
    }
    if (summary.isRunning()) {
      return t('find.status.summarizing');
    }
    if (!state.ran || state.error !== null || state.hits.length === 0) {
      return null;
    }
    const hits = state.hits.length;
    if (prefs.scope === 'file') {
      return t('find.status.hits_note', { hits });
    }
    if (prefs.scope === 'all') {
      return t('find.status.hits_all', { hits });
    }
    return t('find.status.hits', { hits, files: groupHits(state.hits).length });
  };

  // -- body ------------------------------------------------------------------
  const mount = (body: HTMLElement): (() => void) => {
    body.classList.add('find');

    // ONE field for text and tags: a typed `#name` word lifts into a chip.
    const box = el('div', 'find-field');
    const fieldIcon = el('span', 'find-field-icon');
    fieldIcon.appendChild(api.ui.icon('search', 15));
    const tagField = api.ui.createTagField({
      values: state.queryTags,
      onChange: (values) => {
        state.queryTags = values;
        session.notify();
        if (currentMode() === SEARCH_MODE) {
          void session.run();
        }
      },
      ariaLabel: t('find.field.aria'),
      freeText: {
        value: state.queryText,
        onInput: (text) => {
          state.queryText = text;
          session.notify();
        },
        onSubmit: () => {
          if (currentMode() === SEARCH_MODE) {
            void session.run();
          }
        },
      },
    });
    field = tagField;
    const clearButton = iconButton(api, 'x', t('find.clear'), () => {
      clear();
      tagField.setText('');
      tagField.focus();
    });
    const replaceSwitch = iconButton(api, 'replace', t('find.replace'), () => {
      prefs.replaceOpen = !prefs.replaceOpen;
      session.persistPrefs();
      session.notify();
    });
    box.append(fieldIcon, tagField.element, clearButton, replaceSwitch);

    const replaceRow = el('div', 'find-field find-replace');
    const replaceIcon = el('span', 'find-field-icon');
    replaceIcon.appendChild(api.ui.icon('replace', 15));
    const replaceInput = el('input', 'find-input') as HTMLInputElement;
    replaceInput.type = 'text';
    replaceInput.autocomplete = 'off';
    replaceInput.spellcheck = false;
    replaceInput.setAttribute('aria-label', t('find.replace_with'));
    replaceInput.addEventListener('input', () => {
      state.replacement = replaceInput.value;
    });
    const replaceAll = iconButton(api, 'check', t('find.replace_all'), () => replace.replaceAll());
    replaceRow.append(replaceIcon, replaceInput, replaceAll);

    const errorRow = el('p', 'find-error');
    const listHost = el('div', 'find-list');

    // The mode's own list, mounted while its mode is the active one.
    let handle: FindModeHandle | null = null;
    let handleId: string | null = null;
    let offHandle: (() => void) | null = null;
    const teardownMode = (): void => {
      offHandle?.();
      handle?.dispose();
      handle = null;
      handleId = null;
      offHandle = null;
    };
    const openedKey = { value: '' };

    const renderHits = (): void => {
      listHost.textContent = '';
      if (state.error !== null) {
        return;
      }
      if (!state.ran) {
        return;
      }
      if (state.hits.length === 0) {
        listHost.appendChild(el('p', 'find-empty', t('find.empty.hits')));
        return;
      }
      const parsed = session.currentQuery();
      for (const group of groupHits(state.hits)) {
        const wrap = el('div', 'find-group');
        const open = !session.collapsedFiles.has(group.key);
        const head = el('button', 'find-group-head') as HTMLButtonElement;
        head.type = 'button';
        head.setAttribute('aria-expanded', String(open));
        const chevron = el('span', 'find-chevron');
        chevron.appendChild(api.ui.icon('chevron-down', 14));
        const { name, folder } = splitPath(group.path);
        const nameLabel = el('span', 'find-group-name', name);
        head.append(chevron, nameLabel);
        if (folder !== '') {
          head.appendChild(el('span', 'find-group-folder', folder));
        }
        if (group.vaultId !== null && group.vaultId !== session.activeVaultId()) {
          head.appendChild(el('span', 'find-group-vault', group.vaultId));
        }
        head.appendChild(el('span', 'find-group-count', String(group.hits.length)));
        head.title = group.path;
        const rows = el('div', 'find-group-rows');
        rows.hidden = !open;
        head.addEventListener('click', () => {
          const nowOpen = rows.hidden;
          rows.hidden = !nowOpen;
          head.setAttribute('aria-expanded', String(nowOpen));
          if (nowOpen) {
            session.collapsedFiles.delete(group.key);
          } else {
            session.collapsedFiles.add(group.key);
          }
        });
        wrap.append(head, rows);

        for (const hit of group.hits) {
          const key = `${hit.vaultId ?? ''} ${hit.path}:${hit.line}`;
          const row = el('div', 'find-hit-wrap');
          const hitButton = el('button', 'find-hit') as HTMLButtonElement;
          hitButton.type = 'button';
          if (openedKey.value === key) {
            hitButton.setAttribute('aria-current', 'true');
          }
          const top = el('span', 'find-hit-head');
          top.appendChild(el('span', 'find-hit-heading', hit.heading));
          top.appendChild(el('span', 'find-hit-loc', `:${hit.line}`));
          if (hit.unsaved === true) {
            top.appendChild(el('span', 'find-hit-unsaved', t('find.hit.unsaved')));
          }
          const snippet = el('span', 'find-hit-snippet');
          for (const part of snippetParts(hit.snippet, parsed)) {
            snippet.appendChild(
              part.mark ? el('mark', 'find-mark', part.text) : document.createTextNode(part.text),
            );
          }
          hitButton.append(top, snippet);
          hitButton.addEventListener('click', () => {
            openedKey.value = key;
            for (const other of listHost.querySelectorAll('.find-hit[aria-current]')) {
              other.removeAttribute('aria-current');
            }
            hitButton.setAttribute('aria-current', 'true');
            void api.documents.open(hit.path, hit.line, { vaultId: hit.vaultId });
          });
          row.appendChild(hitButton);
          if (prefs.replaceOpen) {
            const one = el('button', 'icon-btn find-hit-replace') as HTMLButtonElement;
            one.type = 'button';
            one.appendChild(api.ui.icon('replace', 14));
            one.title = t('find.hit.replace_file', { path: hit.path });
            one.setAttribute('aria-label', t('find.hit.replace_file', { path: hit.path }));
            one.addEventListener('click', () => replace.replaceInFile(hit));
            row.appendChild(one);
          }
          rows.appendChild(row);
        }
        listHost.appendChild(wrap);
      }
    };

    const render = (): void => {
      // The header status reads plain state: tell the shell it may have changed.
      api.ui.refreshStatus();
      const mode = currentMode();
      const inSearch = mode === SEARCH_MODE;
      replaceSwitch.hidden = !inSearch;
      replaceSwitch.classList.toggle('on', prefs.replaceOpen);
      replaceSwitch.setAttribute('aria-pressed', String(prefs.replaceOpen));
      replaceRow.hidden = !inSearch || !prefs.replaceOpen;
      const hasContent = state.queryTags.length > 0 || state.queryText !== '';
      clearButton.hidden = !hasContent;
      tagField.setValues(state.queryTags);
      if (!box.contains(document.activeElement)) {
        tagField.setText(state.queryText);
      }
      replaceInput.value = state.replacement;
      replaceAll.disabled =
        !session.hasQuery() || (prefs.scope === 'file' && session.activeTextDoc() === null);
      const message = inSearch ? (state.error ?? state.summaryError) : null;
      errorRow.textContent = message ?? '';
      errorRow.hidden = message === null;
      box.classList.toggle('find-field--error', inSearch && state.error !== null);

      if (inSearch) {
        if (handle !== null) {
          teardownMode();
        }
        renderHits();
        return;
      }
      const contrib = activeContrib();
      if (contrib === null) {
        return;
      }
      if (handleId !== contrib.id) {
        teardownMode();
        listHost.textContent = '';
        handle = contrib.mount(listHost, query());
        handleId = contrib.id;
        offHandle = handle.onChange(() => session.notify());
      } else {
        handle?.update(query());
      }
    };

    body.append(box, replaceRow, errorRow, listHost);
    render();
    const unsubscribe = session.subscribe(render);
    modeListeners.add(render);
    const offModes = api.ui.onFindModesChange(render);
    return () => {
      unsubscribe();
      offModes();
      modeListeners.delete(render);
      teardownMode();
      tagField.dispose();
      field = null;
    };
  };

  return {
    widget: {
      id: 'find',
      title: t('find.title'),
      icon: 'search',
      aliases: ['search', 'tasks'],
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 260,
      flush: true,
      status,
      headerTitle,
      headerActions,
      mount,
    },
    focus: () => {
      // The dock may mount the widget lazily; a later tick reaches a fresh mount.
      window.setTimeout(() => field?.focus(), 0);
    },
    resetText: () => field?.setText(''),
    showMode,
  };
}
