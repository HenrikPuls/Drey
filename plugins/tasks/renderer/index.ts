import type {
  DreyPluginApi,
  FindQuery,
  OpenDocumentInfo,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import type { TaskRecord } from '../shared/tasks.js';
import {
  resolveTaskLine,
  scanTasks,
  setDoneOnLine,
  setDueOnLine,
  setPriorityOnLine,
} from '../shared/tasks.js';
import { filterVisibleTasks, readPrefs, writePrefs } from './filter.js';
import { createTasksFindMode } from './find-mode.js';
import { taskToggleExtension, toggleInFocusedSurface } from './task-toggle.js';
import { taskMetaExtension } from './task-meta.js';
import { startReminders } from './reminders.js';
import { createTasksSettingsPage, REMINDERS_ENABLED_KEY } from './settings.js';

/** Files under here are kept out of the vault list (mirrors the main-side index). */
const TEMPLATES_PREFIX = 'templates/';

/** The due-date digest controller (req-65) — stopped in `deactivate`. */
let reminders: ReturnType<typeof startReminders> | null = null;

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
 * the task index in the renderer (document / vault / all-vaults scope), the
 * Tasks mode it offers to the Find panel (req-161, SDK 1.54 find-mode
 * registry: the list, the kind / done / order choices, the pickers) and the
 * `Mod+Enter` checkbox toggle as editor extensions. Plus the daily due-date
 * reminder digest (req-65) and the plugin's Settings page.
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    // -- state ---------------------------------------------------------------
    const prefs = readPrefs();
    const state = {
      hideDone: prefs.hideDone,
      kinds: [...prefs.kinds],
      sort: prefs.sort,
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
      // The scope and the query belong to the Find panel's field now (req-161).
      writePrefs({
        scope: 'vault',
        hideDone: state.hideDone,
        kinds: state.kinds,
        queryTags: [],
        queryText: '',
        sort: state.sort,
      });
    };
    const notify = (): void => {
      persist();
      for (const listener of [...listeners]) {
        listener();
      }
    };

    // -- due-date reminders (req-65) -----------------------------------------
    // One digest per local day over the DISK index (`state.vaultTasks` — a
    // task in an unsaved buffer counts after its save, never before), set
    // in `reminders.ts`. The day gate and the switch live in the plugin
    // config, not the panel's localStorage view prefs.
    reminders = startReminders({
      getTasks: () => state.vaultTasks,
      now: () => new Date(),
      isEnabled: () =>
        api.settings.get<boolean>(REMINDERS_ENABLED_KEY).then((value) => value !== false),
      lastDay: () => api.settings.get<string>('remindersLastDay'),
      setLastDay: (day) => api.settings.set('remindersLastDay', day),
      notify: (request) => void api.ui.notify(request),
      // Find in Tasks mode (the tags plugin's `find.mode` command reveals the panel).
      onClick: () => api.commands.run('find.mode', { mode: 'tasks' }),
    });
    api.ui.registerSettingsPage(createTasksSettingsPage(api));

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
      // The index settled — re-evaluate the daily due-date digest (req-65).
      void reminders?.check();
    };
    void refreshVault();
    // MCP writes / raw writes / manual refresh (no file watcher, ADR-0018).
    api.vault.onChanged(() => void refreshVault());
    // The main-side index builds in the background now (activation no
    // longer waits for it) — this push re-pulls the vault list once the
    // boot sweep finishes, even when no vault-change event fired for it.
    api.backend.on('index-updated', () => void refreshVault());

    /** The tasks the Find panel's query selects: its scope, field and this mode's choices. */
    const visibleTasks = (query: FindQuery): TaskRecord[] => {
      let base: TaskRecord[];
      if (query.scope === 'file') {
        base =
          state.activePath === null
            ? []
            : scanTasks(state.activePath, state.activeBuffer, state.activeVault ?? '');
      } else {
        // Vault scope: exactly the registry's active vault, at pull time.
        // All scope: every known vault — the list is scoped client-side so
        // the active vault is never stale.
        const disk =
          query.scope === 'vault'
            ? state.vaultTasks.filter((t) => t.vaultId === activeVaultId)
            : state.vaultTasks;
        base = withOpenBufferHits(
          disk,
          api.documents.list(),
          query.scope === 'vault' ? activeVaultId : null,
        );
      }
      return filterVisibleTasks(base, {
        kinds: state.kinds,
        hideDone: state.hideDone,
        queryTags: query.tags,
        queryText: query.text,
        sort: state.sort,
      });
    };

    // -- mutating a task line ---------------------------------------------------
    /**
     * Resolves `task` against fresh content and applies `mutate` to the
     * line: an open text tab goes through its live buffer (`setBuffer` +
     * save, so unsaved edits survive — the old base `EditorService`
     * behavior), a closed file is read/patched/written in its own vault
     * and the vault list refreshed. Due/priority changes share the same
     * routing as the done toggle (req-37).
     */
    const applyToTaskLine = async (
      task: TaskRecord,
      mutate: (content: string, line: number) => string,
    ): Promise<void> => {
      // `documents.get` resolves the bare path (active vault first, then a
      // unique open match). The one ambiguous case — the same relative path
      // open from two vaults while the task's vault is not active — falls
      // through to the disk write below, which targets the task's own
      // vault explicitly.
      const open = api.documents.get(task.path);
      if (open !== null && open.kind === 'text') {
        const line = resolveTaskLine(open.buffer, task);
        if (line === null) {
          return;
        }
        const next = mutate(open.buffer, line);
        if (next !== open.buffer) {
          api.documents.setBuffer(task.path, next);
          await api.documents.save(task.path);
        }
        return;
      }
      try {
        const { content } = await api.vault.readFile(task.path, { vaultId: task.vaultId });
        const crlf = content.includes('\r\n');
        const normalized = content.replace(/\r\n/g, '\n');
        const line = resolveTaskLine(normalized, task);
        if (line === null) {
          return;
        }
        const next = mutate(normalized, line);
        if (next !== normalized) {
          await api.vault.writeFile(task.path, crlf ? next.replace(/\n/g, '\r\n') : next, {
            vaultId: task.vaultId,
          });
          await refreshVault();
        }
      } catch {
        return; // Unreadable -- nothing to change.
      }
    };

    // -- Mod+Enter toggle + the Selection-menu row -----------------------------
    api.editor.registerExtension('both', () => taskToggleExtension(api.editor.cm));
    // Due/priority completion on task lines (req-37).
    api.editor.registerExtension('both', () => taskMetaExtension(api.editor.cm));
    api.ui.registerMenuContributions([
      {
        menu: 'selection',
        label: api.i18n.t('tasks.menu.toggle_done'),
        hint: 'Ctrl Enter',
        run: () => {
          toggleInFocusedSurface(api.editor.cm);
        },
      },
    ]);

    // -- the Tasks mode of the Find panel ----------------------------------------
    api.ui.registerFindMode(
      createTasksFindMode(api, {
        visibleTasks,
        prefs: () => ({ hideDone: state.hideDone, kinds: state.kinds, sort: state.sort }),
        setHideDone: (hide) => {
          state.hideDone = hide;
          notify();
        },
        toggleKind: (kind) => {
          const next = state.kinds.includes(kind)
            ? state.kinds.filter((k) => k !== kind)
            : [...state.kinds, kind];
          // Never let the selection reach empty -- that would hide everything.
          if (next.length > 0) {
            state.kinds = next;
            notify();
          }
        },
        setSort: (sort) => {
          state.sort = sort;
          notify();
        },
        vaultName: (vaultId) => vaultNames.get(vaultId) ?? vaultId,
        activeVaultId: () => activeVaultId,
        toggleTask: (task) =>
          applyToTaskLine(task, (content, line) => setDoneOnLine(content, line, !task.done)),
        changeTaskDue: (task, due) =>
          applyToTaskLine(task, (content, line) => setDueOnLine(content, line, due)),
        changeTaskPriority: (task, priority) =>
          applyToTaskLine(task, (content, line) => setPriorityOnLine(content, line, priority)),
        onChange: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      }),
    );
  },

  deactivate() {
    // The reminder interval must not outlive the plugin (a leaking timer);
    // every registration's unsubscribe the host already runs.
    reminders?.stop();
    reminders = null;
  },
};

export default plugin;
