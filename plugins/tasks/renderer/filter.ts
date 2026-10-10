/**
 * The Tasks panel's pure preferences + filtering logic, split out of the
 * DOM panel so it stays unit-testable (the ng test runner ignores
 * `plugins/**` — its spec lives under `src/app/services/`).
 */
import type { TaskKind, TaskRecord } from '../shared/tasks.js';
import { sortTaskRecords } from '../shared/tasks.js';
import { tagSetMatches } from '../shared/support.js';

/** Which set of task lines the panel shows. */
export type TaskScope = 'document' | 'vault' | 'all';

/** The list order: file/document order, due date ascending, or priority. */
export type TaskSort = 'file' | 'due' | 'priority';

export const ALL_SORTS: readonly TaskSort[] = ['file', 'due', 'priority'];

export const ALL_KINDS: readonly TaskKind[] = ['checkbox', 'tag'];

const PREFS_KEY = 'drey.tasks';

export interface TaskPrefs {
  scope: TaskScope;
  hideDone: boolean;
  kinds: TaskKind[];
  /** Tags that must all be present on a task's section (AND). */
  queryTags: string[];
  /** Free text; whitespace-split into terms that must all appear. */
  queryText: string;
  /** The list order (req-37). */
  sort: TaskSort;
}

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase();
}

/** The panel's persisted state (`localStorage['drey.tasks']`), fault-tolerant. */
export function readPrefs(): TaskPrefs {
  const base: TaskPrefs = {
    scope: 'document',
    hideDone: false,
    kinds: [...ALL_KINDS],
    queryTags: [],
    queryText: '',
    sort: 'file',
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
      scope: raw.scope === 'vault' || raw.scope === 'all' ? raw.scope : 'document',
      hideDone: raw.hideDone === true,
      // An empty selection would hide everything with no way back -- keep the default.
      kinds: kinds.length > 0 ? kinds : base.kinds,
      queryTags,
      queryText: typeof raw.queryText === 'string' ? raw.queryText : base.queryText,
      sort: raw.sort === 'due' || raw.sort === 'priority' ? raw.sort : 'file',
    };
  } catch {
    return base;
  }
}

/** Writes the panel state back (same key + shape as before the conversion). */
export function writePrefs(prefs: TaskPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs satisfies TaskPrefs));
  } catch {
    // Private-mode / storage-disabled: a non-persisted session is fine.
  }
}

/** The live filter state the panel applies to either scope's source list. */
export interface TaskFilter {
  readonly kinds: readonly TaskKind[];
  readonly hideDone: boolean;
  readonly queryTags: readonly string[];
  readonly queryText: string;
  /** The list order (req-37). */
  readonly sort: TaskSort;
}

/**
 * Kind / done / tag+text filtering and the list order (req-37). The
 * order comparators are the SHARED view helpers (`shared/tasks.ts`, 57c)
 * — the provider answers assistant/MCP queries with exactly this
 * ordering, so both surfaces always agree.
 */
export function filterVisibleTasks(tasks: readonly TaskRecord[], filter: TaskFilter): TaskRecord[] {
  let list = tasks.filter((t) => filter.kinds.includes(t.kind));
  if (filter.hideDone) {
    list = list.filter((t) => !t.done);
  }
  const qTags = filter.queryTags;
  const terms = filter.queryText
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '');
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
  return sortTaskRecords(list, filter.sort);
}
