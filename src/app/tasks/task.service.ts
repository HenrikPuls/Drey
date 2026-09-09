import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { TaskKind, TaskRecord, scanTasks } from '../../../shared/tasks';
import { EditorService } from '../services/editor.service';

/** Which set of task lines the panel shows. */
export type TaskScope = 'document' | 'vault';

const PREFS_KEY = 'drey.tasks';
const ALL_KINDS: readonly TaskKind[] = ['checkbox', 'tag'];

interface TaskPrefs {
  scope: TaskScope;
  hideDone: boolean;
  kinds: TaskKind[];
}

function readPrefs(): TaskPrefs {
  const base: TaskPrefs = { scope: 'document', hideDone: false, kinds: [...ALL_KINDS] };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<TaskPrefs>;
    const kinds = Array.isArray(raw.kinds)
      ? raw.kinds.filter((k): k is TaskKind => ALL_KINDS.includes(k))
      : base.kinds;
    return {
      scope: raw.scope === 'vault' ? 'vault' : 'document',
      hideDone: raw.hideDone === true,
      // An empty selection would hide everything with no way back -- keep the default.
      kinds: kinds.length > 0 ? kinds : base.kinds,
    };
  } catch {
    return base;
  }
}

/**
 * Task list state for the Tasks dock panel (`TasksPanel`). Mirrors
 * `TagSearchService`: the component only renders and forwards events, the
 * logic lives here.
 *
 * - **document** scope is scanned live from the active editor buffer, so
 *   unsaved edits (and a checkbox ticked in the editor itself) show at once.
 * - **vault** scope comes from the main-process `TaskIndex` via
 *   `listTasks()`, refreshed on construction, after every save, and when an
 *   MCP write reports a vault change (there is no file watcher, ADR-0018).
 */
@Injectable({ providedIn: 'root' })
export class TaskService {
  private readonly editor = inject(EditorService);

  /** The whole-vault list from `TaskIndex`; only consulted in `'vault'` scope. */
  private readonly vaultTasks = signal<TaskRecord[]>([]);

  private readonly prefs = readPrefs();
  readonly scope = signal<TaskScope>(this.prefs.scope);
  readonly hideDone = signal<boolean>(this.prefs.hideDone);
  readonly kinds = signal<TaskKind[]>(this.prefs.kinds);

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  constructor() {
    void this.refresh();
    // Re-pull the vault list whenever a save lands (the active tab's
    // `savedContent` changes). Document scope doesn't need this -- it reads
    // the live buffer -- but vault scope would otherwise go stale.
    effect(() => {
      this.editor.savedContent();
      void this.refresh();
    });
    effect(() => this.persist());
  }

  /** The tasks to render, after scope / kind / done filtering, sorted. */
  readonly visible = computed<TaskRecord[]>(() => {
    const kinds = this.kinds();
    const base =
      this.scope() === 'document'
        ? this.scanActiveDocument()
        : this.vaultTasks();
    let list = base.filter((t) => kinds.includes(t.kind));
    if (this.hideDone()) {
      list = list.filter((t) => !t.done);
    }
    return [...list].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  });

  /** Open (not-done) count among the visible tasks -- shown in the panel header. */
  readonly openCount = computed<number>(() => this.visible().filter((t) => !t.done).length);

  private scanActiveDocument(): TaskRecord[] {
    const path = this.editor.openPath();
    if (path === null || this.editor.activeKind() === 'image') {
      return [];
    }
    return scanTasks(path, this.editor.bufferContent());
  }

  async refresh(): Promise<void> {
    if (!this.api?.listTasks) {
      return;
    }
    try {
      this.vaultTasks.set(await this.api.listTasks());
    } catch {
      this.vaultTasks.set([]);
    }
  }

  setScope(scope: TaskScope): void {
    this.scope.set(scope);
  }

  toggleHideDone(): void {
    this.hideDone.update((v) => !v);
  }

  /** Flip one task kind in/out of the shown set; never lets it reach empty. */
  toggleKind(kind: TaskKind): void {
    this.kinds.update((list) => {
      const next = list.includes(kind) ? list.filter((k) => k !== kind) : [...list, kind];
      return next.length > 0 ? next : list;
    });
  }

  hasKind(kind: TaskKind): boolean {
    return this.kinds().includes(kind);
  }

  /** Tick / untick a task in its source file (`EditorService.setTaskDone`). */
  async toggle(task: TaskRecord): Promise<void> {
    await this.editor.setTaskDone(task.path, task.line, !task.done);
    await this.refresh();
  }

  /** Open the task's file at its line (same as a search hit). */
  open(task: TaskRecord): void {
    void this.editor.openFileAt(task.path, task.line);
  }

  private persist(): void {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          scope: this.scope(),
          hideDone: this.hideDone(),
          kinds: this.kinds(),
        } satisfies TaskPrefs),
      );
    } catch {
      // Private-mode / storage-disabled: a non-persisted session is fine.
    }
  }
}
