import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { TaskKind, TaskRecord, scanTasks } from '../../../shared/tasks';
import { tagSetMatches } from '../../../shared/tags';
import { EditorService } from '../services/editor.service';

/** Which set of task lines the panel shows. */
export type TaskScope = 'document' | 'vault';

const PREFS_KEY = 'drey.tasks';
const ALL_KINDS: readonly TaskKind[] = ['checkbox', 'tag'];

interface TaskPrefs {
  scope: TaskScope;
  hideDone: boolean;
  kinds: TaskKind[];
  /** Tags that must all be present on a task's section (AND). */
  queryTags: string[];
  /** Free text; whitespace-split into terms that must all appear. */
  queryText: string;
}

function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase();
}

function readPrefs(): TaskPrefs {
  const base: TaskPrefs = {
    scope: 'document',
    hideDone: false,
    kinds: [...ALL_KINDS],
    queryTags: [],
    queryText: '',
  };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<TaskPrefs>;
    const kinds = Array.isArray(raw.kinds)
      ? raw.kinds.filter((k): k is TaskKind => ALL_KINDS.includes(k))
      : base.kinds;
    const queryTags = Array.isArray(raw.queryTags)
      ? [...new Set(raw.queryTags.map(normalizeTag).filter((t) => t !== ''))]
      : base.queryTags;
    return {
      scope: raw.scope === 'vault' ? 'vault' : 'document',
      hideDone: raw.hideDone === true,
      // An empty selection would hide everything with no way back -- keep the default.
      kinds: kinds.length > 0 ? kinds : base.kinds,
      queryTags,
      queryText: typeof raw.queryText === 'string' ? raw.queryText : base.queryText,
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
  /** Free-text + multi-tag filter (req-8), matched against each task's section tags / text. */
  readonly queryTags = signal<string[]>(this.prefs.queryTags);
  readonly queryText = signal<string>(this.prefs.queryText);
  readonly hasFilter = computed<boolean>(
    () => this.queryTags().length > 0 || this.queryText().trim() !== '',
  );

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

  /** The tasks to render, after scope / kind / done / text+tag filtering, sorted. */
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
    const qTags = this.queryTags();
    const terms = this.queryText().toLowerCase().split(/\s+/).filter((t) => t !== '');
    if (qTags.length > 0 || terms.length > 0) {
      list = list.filter((t) => {
        const tset = new Set(t.tags.map((x) => x.toLowerCase()));
        if (!qTags.every((q) => tagSetMatches(tset, q))) {
          return false;
        }
        const hay = `${t.text}\n${t.heading ?? ''}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      });
    }
    return [...list].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  });

  /** Open (not-done) count among the visible tasks -- shown in the panel header. */
  readonly openCount = computed<number>(() => this.visible().filter((t) => !t.done).length);

  private scanActiveDocument(): TaskRecord[] {
    const path = this.editor.openPath();
    if (path === null || this.editor.activeKind() !== 'text') {
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

  /** Add a tag to the filter (leading `#` and case are normalised; dupes ignored). */
  addTag(raw: string): void {
    const tag = normalizeTag(raw);
    if (tag === '' || this.queryTags().includes(tag)) {
      return;
    }
    this.queryTags.update((list) => [...list, tag]);
  }

  removeTag(tag: string): void {
    this.queryTags.update((list) => list.filter((t) => t !== tag));
  }

  setText(value: string): void {
    this.queryText.set(value);
  }

  /** Drop the whole free-text + tag filter. */
  clearFilter(): void {
    this.queryTags.set([]);
    this.queryText.set('');
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
          queryTags: this.queryTags(),
          queryText: this.queryText(),
        } satisfies TaskPrefs),
      );
    } catch {
      // Private-mode / storage-disabled: a non-persisted session is fine.
    }
  }
}
