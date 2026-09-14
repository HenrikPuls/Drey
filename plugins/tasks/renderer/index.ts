import type {
  DreyPluginApi,
  OpenDocumentInfo,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import type { TaskRecord } from '../shared/tasks.js';
import { resolveTaskLine, scanTasks, setDoneOnLine } from '../shared/tasks.js';
import {
  ALL_KINDS,
  filterVisibleTasks,
  normalizeTag,
  readPrefs,
  writePrefs,
  type TaskScope,
} from './filter.js';
import { taskToggleExtension, toggleInFocusedSurface } from './task-toggle.js';

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

function toggleButton(
  className: string,
  label: string,
  title: string,
  onPress: () => void,
): HTMLButtonElement {
  const node = el('button', className, label) as HTMLButtonElement;
  node.type = 'button';
  node.title = title;
  node.setAttribute('aria-label', title);
  node.addEventListener('click', onPress);
  return node;
}

/** Files under here are kept out of the vault list (mirrors the main-side index). */
const TEMPLATES_PREFIX = 'templates/';

/**
 * Open tabs with UNSAVED edits replace their own on-disk hits with what
 * their current buffer matches — the whole-vault list reflects an editor
 * checkbox click (or any edit) immediately, saved or not; previously an
 * editor-side toggle only dirtied the buffer and the disk index (and so
 * the list) never adopted it until an unrelated save. Same fold the Tags
 * plugin's search runs over dirty tabs.
 */
function withOpenBufferHits(disk: TaskRecord[], docs: readonly OpenDocumentInfo[]): TaskRecord[] {
  const dirty = docs.filter(
    (doc) => doc.kind === 'text' && doc.dirty && !doc.path.startsWith(TEMPLATES_PREFIX),
  );
  if (dirty.length === 0) {
    return disk;
  }
  const dirtyPaths = new Set(dirty.map((doc) => doc.path));
  const merged = disk.filter((task) => !dirtyPaths.has(task.path));
  for (const doc of dirty) {
    merged.push(...scanTasks(doc.path, doc.buffer));
  }
  // File order then document order — keeps the vault view's per-file
  // groups adjacent.
  merged.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return merged;
}

/**
 * The Tasks plugin's renderer (ADR-0033, converted in ADR-0044 stage 6):
 * the Tasks dock panel (document / whole-vault scope, hide-done and kind
 * filters, tag+text filter) and the `Mod+Enter` checkbox toggle as editor
 * extensions — ported from `src/app/tasks/` to plain DOM.
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    // -- state ---------------------------------------------------------------
    const prefs = readPrefs();
    const state = {
      scope: prefs.scope,
      hideDone: prefs.hideDone,
      kinds: [...prefs.kinds],
      queryTags: [...prefs.queryTags],
      queryText: prefs.queryText,
      /** The whole-vault list from the plugin main; only read in vault scope. */
      vaultTasks: [] as TaskRecord[],
      activePath: null as string | null,
      activeBuffer: '',
    };
    const listeners = new Set<() => void>();
    const persist = (): void => {
      writePrefs({
        scope: state.scope,
        hideDone: state.hideDone,
        kinds: state.kinds,
        queryTags: state.queryTags,
        queryText: state.queryText,
      });
    };
    const notify = (): void => {
      persist();
      for (const listener of [...listeners]) {
        listener();
      }
    };

    // -- document scope: the focused pane's live buffer ----------------------
    const pullActive = (): void => {
      const active = api.documents.active();
      const isText = active !== null && active.kind === 'text';
      state.activePath = isText ? active.path : null;
      state.activeBuffer = isText ? active.buffer : '';
    };
    pullActive();
    api.documents.onChange((event) => {
      if (event.type === 'active-changed' || event.type === 'docs-changed') {
        pullActive();
        notify();
        return;
      }
      if (event.type === 'buffer-changed' && event.path === state.activePath) {
        state.activeBuffer = event.content;
        notify();
        return;
      }
      if (event.type === 'dirty-changed' && !event.dirty) {
        // A save just landed -- the vault list would otherwise go stale.
        void refreshVault();
      }
    });

    // -- vault scope: the main-side index, via the plugin bridge -------------
    const refreshVault = async (): Promise<void> => {
      try {
        state.vaultTasks = ((await api.backend.invoke('list')) as TaskRecord[]) ?? [];
      } catch {
        state.vaultTasks = [];
      }
      notify();
    };
    void refreshVault();
    // MCP writes / raw writes / manual refresh (no file watcher, ADR-0018).
    api.vault.onChanged(() => void refreshVault());
    // The main-side index builds in the background now (activation no
    // longer waits for it) — this push re-pulls the vault list once the
    // boot sweep finishes, even when no vault-change event fired for it.
    api.backend.on('index-updated', () => void refreshVault());

    const visibleTasks = (): TaskRecord[] => {
      const base =
        state.scope === 'document'
          ? state.activePath === null
            ? []
            : scanTasks(state.activePath, state.activeBuffer)
          : withOpenBufferHits(state.vaultTasks, api.documents.list());
      return filterVisibleTasks(base, state);
    };

    const hasFilter = (): boolean => state.queryTags.length > 0 || state.queryText.trim() !== '';

    // -- mutations -------------------------------------------------------------
    const setScope = (scope: TaskScope): void => {
      state.scope = scope;
      notify();
    };
    const toggleHideDone = (): void => {
      state.hideDone = !state.hideDone;
      notify();
    };
    const toggleKind = (kind: (typeof ALL_KINDS)[number]): void => {
      const next = state.kinds.includes(kind)
        ? state.kinds.filter((k) => k !== kind)
        : [...state.kinds, kind];
      // Never let the selection reach empty -- that would hide everything.
      if (next.length > 0) {
        state.kinds = next;
        notify();
      }
    };
    const addTag = (raw: string): void => {
      const tag = normalizeTag(raw);
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
    const setText = (value: string): void => {
      state.queryText = value;
      notify();
    };
    const clearFilter = (): void => {
      state.queryTags = [];
      state.queryText = '';
      notify();
    };

    // -- ticking a task --------------------------------------------------------
    const toggleTask = async (task: TaskRecord): Promise<void> => {
      const open = api.documents.get(task.path);
      if (open !== null && open.kind === 'text') {
        // Through the live buffer, saved like any edit (an unsaved change
        // in that tab is never lost) -- exactly what the base
        // `EditorService.setTaskDone` did. The line resolves against the
        // CURRENT buffer (`resolveTaskLine`): the save pipeline's
        // frontmatter bump shifts lines, and a row rendered before that
        // shift would otherwise toggle nothing.
        const line = resolveTaskLine(open.buffer, task);
        if (line === null) {
          return;
        }
        const next = setDoneOnLine(open.buffer, line, !task.done);
        if (next !== open.buffer) {
          api.documents.setBuffer(task.path, next);
          await api.documents.save(task.path);
        }
        return;
      }
      let changed = false;
      try {
        const { content } = await api.vault.readFile(task.path);
        const crlf = content.includes('\r\n');
        const normalized = content.replace(/\r\n/g, '\n');
        const line = resolveTaskLine(normalized, task);
        if (line === null) {
          return;
        }
        const next = setDoneOnLine(normalized, line, !task.done);
        if (next !== normalized) {
          await api.vault.writeFile(task.path, crlf ? next.replace(/\n/g, '\r\n') : next);
          changed = true;
        }
      } catch {
        return; // Unreadable -- nothing to toggle.
      }
      if (changed) {
        await refreshVault();
      }
    };

    // -- Mod+Enter toggle + the Selection-menu row -----------------------------
    api.editor.registerExtension('both', () => taskToggleExtension(api.editor.cm));
    api.ui.registerMenuContributions([
      {
        menu: 'selection',
        label: 'Toggle task done',
        hint: 'Ctrl Enter',
        run: () => {
          toggleInFocusedSurface(api.editor.cm);
        },
      },
    ]);

    // -- the Tasks dock panel ---------------------------------------------------
    api.ui.registerWidget({
      id: 'tasks',
      title: 'Tasks',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 220,
      flush: true,
      status: () => {
        const open = visibleTasks().filter((t) => !t.done).length;
        return open > 0 ? `${open} open` : null;
      },
      headerActions: (host) => {
        const row = el('div', 'tasks-hdr');
        const seg = el('span', 'seg');
        seg.setAttribute('role', 'tablist');
        seg.setAttribute('aria-label', 'Task scope');
        const docBtn = toggleButton('', 'Doc', 'Tasks in the open document', () =>
          setScope('document'),
        );
        docBtn.setAttribute('role', 'tab');
        const vaultBtn = toggleButton('', 'Vault', 'Tasks across the whole vault', () =>
          setScope('vault'),
        );
        vaultBtn.setAttribute('role', 'tab');
        seg.append(docBtn, vaultBtn);

        const doneBtn = toggleButton('tgl', 'done', 'Hide completed tasks', toggleHideDone);
        const boxBtn = toggleButton('tgl', '[ ]', 'Show - [ ] checkbox tasks', () =>
          toggleKind('checkbox'),
        );
        const tagBtn = toggleButton('tgl', '#', 'Show lines tagged #task', () =>
          toggleKind('tag'),
        );
        row.append(seg, doneBtn, boxBtn, tagBtn);

        const render = (): void => {
          docBtn.classList.toggle('on', state.scope === 'document');
          docBtn.setAttribute('aria-selected', String(state.scope === 'document'));
          vaultBtn.classList.toggle('on', state.scope === 'vault');
          vaultBtn.setAttribute('aria-selected', String(state.scope === 'vault'));
          for (const [btn, on] of [
            [doneBtn, state.hideDone],
            [boxBtn, state.kinds.includes('checkbox')],
            [tagBtn, state.kinds.includes('tag')],
          ] as const) {
            btn.classList.toggle('on', on);
            btn.setAttribute('aria-pressed', String(on));
          }
        };
        render();
        listeners.add(render);
        host.appendChild(row);
        return () => {
          listeners.delete(render);
        };
      },
      mount: (body) => {
        body.classList.add('tasks-panel');

        // -- filter block (pinned; only the list scrolls -- widget is flush) --
        const chipField = el('div', 'chip-field');
        const chipInput = el('input', 'chip-input') as HTMLInputElement;
        chipInput.type = 'text';
        chipInput.autocomplete = 'off';
        chipInput.placeholder = '+ tag';
        const textInput = el('input', 'text-input') as HTMLInputElement;
        textInput.type = 'text';
        textInput.autocomplete = 'off';
        textInput.placeholder = 'filter text…';
        const clearButton = toggleButton('clear', 'Clear filter', 'Drop the filter', clearFilter);
        clearButton.className = 'clear';

        const filter = el('div', 'filter');
        const content = el('div', 'content');

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

        const taskRow = (task: TaskRecord, showLoc: boolean): HTMLElement => {
          const wrap = el('div', 'task');
          if (task.done) {
            wrap.classList.add('done');
          }
          const box = el('input', 'box') as HTMLInputElement;
          box.type = 'checkbox';
          box.checked = task.done;
          box.setAttribute('aria-label', task.done ? 'Mark not done' : 'Mark done');
          box.addEventListener('change', () => void toggleTask(task));

          const bodyButton = el('button', 'body') as HTMLButtonElement;
          bodyButton.type = 'button';
          bodyButton.appendChild(el('span', 'text', task.text || '(untitled task)'));
          const meta = el('span', 'meta');
          if (task.kind === 'tag') {
            meta.appendChild(el('span', 'kind', '#task'));
          }
          if (task.heading !== null) {
            meta.appendChild(el('span', 'heading', task.heading));
          }
          if (showLoc) {
            meta.appendChild(el('span', 'loc', `:${task.line}`));
          }
          bodyButton.appendChild(meta);
          bodyButton.addEventListener('click', () => void api.documents.open(task.path, task.line));

          wrap.append(box, bodyButton);
          return wrap;
        };

        const renderContent = (): void => {
          content.textContent = '';
          const visible = visibleTasks();
          if (visible.length === 0) {
            content.appendChild(
              el(
                'p',
                'empty',
                hasFilter()
                  ? 'No tasks match the filter.'
                  : state.scope === 'document'
                    ? 'No tasks in this document.'
                    : 'No tasks in the vault.',
              ),
            );
            return;
          }
          const list = el('div', 'list');
          if (state.scope === 'document') {
            for (const task of visible) {
              list.appendChild(taskRow(task, false));
            }
          } else {
            // Grouped by file; the full path disambiguates same-named notes.
            let lastPath: string | null = null;
            for (const task of visible) {
              if (task.path !== lastPath) {
                lastPath = task.path;
                const group = el('p', 'group', task.path);
                group.title = task.path;
                list.appendChild(group);
              }
              list.appendChild(taskRow(task, true));
            }
          }
          content.appendChild(list);
        };

        const render = (): void => {
          renderChips();
          textInput.value = state.queryText;
          clearButton.style.display = hasFilter() ? '' : 'none';
          renderContent();
        };

        // Enter / comma commits the typed tag; Backspace on an empty field
        // pops the last chip; blur commits a partial entry.
        chipInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            if (chipInput.value.trim() !== '') {
              addTag(chipInput.value);
              chipInput.value = '';
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
          setText(textInput.value);
        });

        filter.append(chipField, textInput, clearButton);
        body.append(filter, content);
        render();
        listeners.add(render);
        return () => {
          listeners.delete(render);
        };
      },
    });
  },
};

export default plugin;
