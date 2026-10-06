import type {
  DreyPluginApi,
  OpenDocumentInfo,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import type { TaskRecord } from '../shared/tasks.js';
import { resolveTaskLine, scanTasks, setDoneOnLine } from '../shared/tasks.js';
import { ALL_KINDS, filterVisibleTasks, readPrefs, writePrefs, type TaskScope } from './filter.js';
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

/** Files under here are kept out of the vault list (mirrors the main-side index). */
const TEMPLATES_PREFIX = 'templates/';

/**
 * Open tabs with UNSAVED edits replace their own on-disk hits with what
 * their current buffer matches — the whole-vault list reflects an editor
 * checkbox click (or any edit) immediately, saved or not; previously an
 * editor-side toggle only dirtied the buffer and the disk index (and so
 * the list) never adopted it until an unrelated save. Same fold the Tags
 * plugin's search runs over dirty tabs. The merge is keyed by
 * `vaultId` + path (two vaults may hold the same relative path), and
 * `scopeVaultId` narrows it to one vault (`null` = every vault, the All
 * scope); never-located scratch tabs hold no vault content either way.
 */
function withOpenBufferHits(
  disk: TaskRecord[],
  docs: readonly OpenDocumentInfo[],
  scopeVaultId: string | null,
): TaskRecord[] {
  const dirty = docs.filter(
    (doc) =>
      doc.kind === 'text' &&
      doc.dirty &&
      doc.vaultId !== null &&
      (scopeVaultId === null || doc.vaultId === scopeVaultId) &&
      !doc.path.startsWith(TEMPLATES_PREFIX),
  );
  if (dirty.length === 0) {
    return disk;
  }
  const dirtyKeys = new Set(dirty.map((doc) => `${doc.vaultId} ${doc.path}`));
  const merged = disk.filter((task) => !dirtyKeys.has(`${task.vaultId} ${task.path}`));
  for (const doc of dirty) {
    merged.push(...scanTasks(doc.path, doc.buffer, doc.vaultId ?? ''));
  }
  // Vault order, then file order, then document order — keeps the grouped
  // view's per-file sections adjacent in every scope.
  merged.sort(
    (a, b) => a.vaultId.localeCompare(b.vaultId) || a.path.localeCompare(b.path) || a.line - b.line,
  );
  return merged;
}

/**
 * The Tasks plugin's renderer (ADR-0033, converted in ADR-0044 stage 6):
 * the Tasks dock panel (document / vault / all-vaults scope, hide-done and
 * kind filters, tag+text filter) and the `Mod+Enter` checkbox toggle as
 * editor extensions — ported from `src/app/tasks/` to plain DOM.
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
      /** The index list from the plugin main (every vault, vaultId-stamped). */
      vaultTasks: [] as TaskRecord[],
      activePath: null as string | null,
      /** The active document's vault (document-scope records are stamped with it). */
      activeVault: null as string | null,
      activeBuffer: '',
    };
    const listeners = new Set<() => void>();
    /** The vault registry (ADR-0051) for the Vault scope + the group badges. */
    let vaultNames = new Map<string, string>();
    let activeVaultId: string | null = null;
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
      state.activeVault = isText ? active.vaultId : null;
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

    // -- vault / all scope: the main-side index, via the plugin bridge -------
    const refreshVault = async (): Promise<void> => {
      try {
        const [tasks, vaults] = (await Promise.all([
          api.backend.invoke('list'),
          api.vault.listVaults(),
        ])) as [TaskRecord[], readonly { id: string; name: string; active: boolean }[]];
        state.vaultTasks = tasks ?? [];
        vaultNames = new Map(vaults.map((v) => [v.id, v.name]));
        activeVaultId = vaults.find((v) => v.active)?.id ?? null;
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
      let base: TaskRecord[];
      if (state.scope === 'document') {
        base =
          state.activePath === null
            ? []
            : scanTasks(state.activePath, state.activeBuffer, state.activeVault ?? '');
      } else {
        // Vault scope: exactly the registry's active vault, at pull time.
        // All scope: every known vault — the panel scopes the main-side
        // list client-side so the active vault is never stale.
        const disk =
          state.scope === 'vault'
            ? state.vaultTasks.filter((t) => t.vaultId === activeVaultId)
            : state.vaultTasks;
        base = withOpenBufferHits(
          disk,
          api.documents.list(),
          state.scope === 'vault' ? activeVaultId : null,
        );
      }
      return filterVisibleTasks(base, state);
    };

    const hasFilter = (): boolean => state.queryTags.length > 0 || state.queryText.trim() !== '';

    /** Icon-only control: the words live in `title` + `aria-label`. */
    const iconButton = (icon: string, label: string, onClick: () => void): HTMLButtonElement => {
      const node = el('button', 'icon-btn') as HTMLButtonElement;
      node.type = 'button';
      node.appendChild(api.ui.icon(icon, 14));
      node.title = label;
      node.setAttribute('aria-label', label);
      node.addEventListener('click', onClick);
      return node;
    };

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
      // `documents.get` resolves the bare path (active vault first, then a
      // unique open match). The one ambiguous case — the same relative path
      // open from two vaults while the task's vault is not active — falls
      // through to the disk write below, which targets the task's own
      // vault explicitly.
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
        const { content } = await api.vault.readFile(task.path, { vaultId: task.vaultId });
        const crlf = content.includes('\r\n');
        const normalized = content.replace(/\r\n/g, '\n');
        const line = resolveTaskLine(normalized, task);
        if (line === null) {
          return;
        }
        const next = setDoneOnLine(normalized, line, !task.done);
        if (next !== normalized) {
          await api.vault.writeFile(task.path, crlf ? next.replace(/\n/g, '\r\n') : next, {
            vaultId: task.vaultId,
          });
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
        const seg = el('span', 'seg');
        seg.setAttribute('role', 'tablist');
        seg.setAttribute('aria-label', 'Task scope');
        const scopes: Array<[TaskScope, string, string]> = [
          ['document', 'file-text', 'Tasks in the open document'],
          ['vault', 'folder', 'Tasks across the whole vault'],
          ['all', 'layers', 'Tasks across every vault'],
        ];
        const buttons = scopes.map(([scope, icon, label]) => {
          const btn = iconButton(icon, label, () => setScope(scope));
          btn.setAttribute('role', 'tab');
          btn.dataset['scope'] = scope;
          seg.appendChild(btn);
          return btn;
        });

        const render = (): void => {
          for (const btn of buttons) {
            const on = btn.dataset['scope'] === state.scope;
            btn.classList.toggle('on', on);
            btn.setAttribute('aria-selected', String(on));
          }
        };
        render();
        listeners.add(render);
        host.appendChild(seg);
        return () => {
          listeners.delete(render);
        };
      },
      mount: (body) => {
        body.classList.add('tasks-panel');

        // -- filter block (pinned; only the list scrolls -- widget is flush) --
        // ONE field (milestone 43): the shared tag field in free-text mode,
        // so a typed `#name` becomes a chip and the rest filters by text;
        // the three view toggles sit at its right edge as icons.
        const fieldIcon = el('span', 'filter-icon');
        fieldIcon.appendChild(api.ui.icon('filter', 14));
        const tagField = api.ui.createTagField({
          values: state.queryTags,
          onChange: (values) => {
            state.queryTags = values;
            notify();
          },
          ariaLabel: 'Filter tasks by text and #tags',
          freeText: {
            value: state.queryText,
            onInput: (text) => setText(text),
          },
        });
        const clearButton = iconButton('x', 'Clear filter', clearFilter);
        const doneBtn = iconButton('circle-check', 'Hide completed tasks', toggleHideDone);
        const boxBtn = iconButton('check-square', 'Show - [ ] checkbox tasks', () =>
          toggleKind('checkbox'),
        );
        const tagBtn = iconButton('hash', 'Show lines tagged #task', () => toggleKind('tag'));
        for (const btn of [doneBtn, boxBtn, tagBtn]) {
          btn.setAttribute('aria-pressed', 'false');
        }

        const filter = el('div', 'filter');
        const content = el('div', 'content');

        const renderChips = (): void => {
          tagField.setValues(state.queryTags);
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
          bodyButton.addEventListener(
            'click',
            () => void api.documents.open(task.path, task.line, { vaultId: task.vaultId }),
          );

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
                    : state.scope === 'vault'
                      ? 'No tasks in the vault.'
                      : 'No tasks in any vault.',
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
            // Grouped by file; the full path disambiguates same-named
            // notes, and in the All scope a badge names every group's
            // vault (the active one stays unbadged, like the Search panel).
            let lastKey: string | null = null;
            for (const task of visible) {
              const key = `${task.vaultId} ${task.path}`;
              if (key !== lastKey) {
                lastKey = key;
                const group = el('p', 'group', task.path);
                group.title = task.path;
                if (task.vaultId !== activeVaultId) {
                  group.appendChild(
                    el('span', 'vault', vaultNames.get(task.vaultId) ?? task.vaultId),
                  );
                }
                list.appendChild(group);
              }
              list.appendChild(taskRow(task, true));
            }
          }
          content.appendChild(list);
        };

        const render = (): void => {
          renderChips();
          if (!filter.contains(document.activeElement)) {
            tagField.setText(state.queryText);
          }
          clearButton.hidden = !hasFilter();
          for (const [btn, on] of [
            [doneBtn, state.hideDone],
            [boxBtn, state.kinds.includes('checkbox')],
            [tagBtn, state.kinds.includes('tag')],
          ] as const) {
            btn.classList.toggle('on', on);
            btn.setAttribute('aria-pressed', String(on));
          }
          renderContent();
        };

        filter.append(fieldIcon, tagField.element, clearButton, doneBtn, boxBtn, tagBtn);
        body.append(filter, content);
        render();
        listeners.add(render);
        return () => {
          listeners.delete(render);
          tagField.dispose();
        };
      },
    });
  },
};

export default plugin;
