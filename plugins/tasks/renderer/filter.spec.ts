// @vitest-environment jsdom
import {
  filterVisibleTasks,
  normalizeTag,
  readPrefs,
  writePrefs,
  type TaskFilter,
} from './filter';
import type { TaskRecord } from '../shared/tasks';

/**
 * The Tasks plugin's panel filter + persisted preferences
 * (`plugins/tasks/renderer/filter`), relocated from the old
 * `TaskService` spec at the ADR-0044 stage-6 conversion.
 */

/** Index-scope tasks, as the plugin main's `list` returns them (vaultId-stamped). */
const VAULT_TASKS: TaskRecord[] = [
  {
    path: 'a.md',
    vaultId: 'home',
    line: 3,
    text: 'draft the brief',
    done: false,
    kind: 'checkbox',
    heading: 'Projekt Alpha',
    tags: ['project', 'project/frontend'],
    due: null,
    priority: null,
  },
  {
    path: 'a.md',
    vaultId: 'home',
    line: 4,
    text: 'send the invoice',
    done: true,
    kind: 'checkbox',
    heading: 'Projekt Alpha',
    tags: ['project', 'buchhaltung'],
    due: null,
    priority: null,
  },
  {
    path: 'b.md',
    vaultId: 'home',
    line: 9,
    text: 'call the landlord',
    done: false,
    kind: 'tag',
    heading: 'Wohnung',
    tags: ['wohnung'],
    due: null,
    priority: null,
  },
  {
    path: 'b.md',
    vaultId: 'home',
    line: 12,
    text: 'water the plants',
    done: false,
    kind: 'checkbox',
    heading: null,
    tags: [],
    due: null,
    priority: null,
  },
];

const NO_FILTER: TaskFilter = {
  kinds: ['checkbox', 'tag'],
  hideDone: false,
  queryTags: [],
  queryText: '',
  sort: 'file',
};

describe('Tasks plugin filter (req-8)', () => {
  it('shows everything with no filter, sorted by file then line', () => {
    expect(filterVisibleTasks(VAULT_TASKS, NO_FILTER).map((t) => t.text)).toEqual([
      'draft the brief',
      'send the invoice',
      'call the landlord',
      'water the plants',
    ]);
  });

  it('filters by a section tag (AND across tags)', () => {
    expect(
      filterVisibleTasks(VAULT_TASKS, { ...NO_FILTER, queryTags: ['project'] }).map((t) => t.text),
    ).toEqual(['draft the brief', 'send the invoice']);

    expect(
      filterVisibleTasks(VAULT_TASKS, {
        ...NO_FILTER,
        queryTags: ['project', 'buchhaltung'],
      }).map((t) => t.text),
    ).toEqual(['send the invoice']);
  });

  it('matches a parent tag against a nested section tag', () => {
    // Only a.md line 3 carries `project/frontend`.
    expect(
      filterVisibleTasks(VAULT_TASKS, { ...NO_FILTER, queryTags: ['project/frontend'] }).map(
        (t) => t.text,
      ),
    ).toEqual(['draft the brief']);
  });

  it('filters by free text (AND across whitespace terms, over text + heading)', () => {
    expect(
      filterVisibleTasks(VAULT_TASKS, { ...NO_FILTER, queryText: 'landlord' }).map((t) => t.text),
    ).toEqual(['call the landlord']);

    expect(
      filterVisibleTasks(VAULT_TASKS, { ...NO_FILTER, queryText: 'the wohnung' }).map(
        (t) => t.text,
      ),
    ).toEqual(['call the landlord']);
  });

  it('combines tag and text terms with AND', () => {
    expect(
      filterVisibleTasks(VAULT_TASKS, {
        ...NO_FILTER,
        queryTags: ['project'],
        queryText: 'brief',
      }).map((t) => t.text),
    ).toEqual(['draft the brief']);
  });

  it('hides done tasks and filters by kind', () => {
    expect(
      filterVisibleTasks(VAULT_TASKS, { ...NO_FILTER, hideDone: true }).map((t) => t.text),
    ).toEqual(['draft the brief', 'call the landlord', 'water the plants']);

    expect(
      filterVisibleTasks(VAULT_TASKS, { ...NO_FILTER, kinds: ['tag'] }).map((t) => t.text),
    ).toEqual(['call the landlord']);
  });

  it('normalizes typed tags (leading #, case, whitespace)', () => {
    expect(normalizeTag('  #Project ')).toBe('project');
  });

  it('sorts by due date ascending, undated last (req-37)', () => {
    const dated: TaskRecord[] = [
      { ...VAULT_TASKS[0]!, due: '2026-03-02' },
      { ...VAULT_TASKS[1]!, done: false, due: '2026-01-15' },
      { ...VAULT_TASKS[2]!, due: null },
      { ...VAULT_TASKS[3]!, due: '2026-02-20' },
    ];
    expect(filterVisibleTasks(dated, { ...NO_FILTER, sort: 'due' }).map((t) => t.due)).toEqual([
      '2026-01-15',
      '2026-02-20',
      '2026-03-02',
      null,
    ]);
  });

  it('sorts by priority: highest, high, normal, low (req-37)', () => {
    const ranked: TaskRecord[] = [
      { ...VAULT_TASKS[0]!, priority: null },
      { ...VAULT_TASKS[1]!, done: false, priority: 'low' },
      { ...VAULT_TASKS[2]!, priority: 'high' },
      { ...VAULT_TASKS[3]!, priority: 'highest' },
    ];
    expect(
      filterVisibleTasks(ranked, { ...NO_FILTER, sort: 'priority' }).map((t) => t.priority),
    ).toEqual(['highest', 'high', null, 'low']);
  });

  it('ties in both sorts fall back to path then line', () => {
    const tied: TaskRecord[] = [
      { ...VAULT_TASKS[3]!, due: '2026-01-01' },
      { ...VAULT_TASKS[0]!, due: '2026-01-01' },
    ];
    expect(filterVisibleTasks(tied, { ...NO_FILTER, sort: 'due' }).map((t) => t.path)).toEqual([
      'a.md',
      'b.md',
    ]);
    const tiedPriority: TaskRecord[] = [
      { ...VAULT_TASKS[3]!, priority: 'high' },
      { ...VAULT_TASKS[0]!, priority: 'high' },
    ];
    expect(
      filterVisibleTasks(tiedPriority, { ...NO_FILTER, sort: 'priority' }).map((t) => t.path),
    ).toEqual(['a.md', 'b.md']);
  });
});

describe('Tasks plugin persisted prefs', () => {
  beforeEach(() => {
    localStorage.removeItem('drey.tasks');
  });

  afterEach(() => {
    localStorage.removeItem('drey.tasks');
  });

  it('defaults to document scope, everything shown, no filter', () => {
    expect(readPrefs()).toEqual({
      scope: 'document',
      hideDone: false,
      kinds: ['checkbox', 'tag'],
      queryTags: [],
      queryText: '',
      sort: 'file',
    });
  });

  it('round-trips through writePrefs (same key + shape as before the conversion)', () => {
    writePrefs({
      scope: 'vault',
      hideDone: true,
      kinds: ['checkbox'],
      queryTags: ['project'],
      queryText: 'brief',
      sort: 'due',
    });
    expect(readPrefs()).toEqual({
      scope: 'vault',
      hideDone: true,
      kinds: ['checkbox'],
      queryTags: ['project'],
      queryText: 'brief',
      sort: 'due',
    });
  });

  it('persists the all-vaults scope (milestone 34)', () => {
    writePrefs({
      scope: 'all',
      hideDone: false,
      kinds: ['checkbox', 'tag'],
      queryTags: [],
      queryText: '',
      sort: 'file',
    });
    expect(readPrefs().scope).toBe('all');
  });

  it('ignores a corrupt blob and an unknown scope', () => {
    localStorage.setItem('drey.tasks', '{ not json');
    expect(readPrefs().scope).toBe('document');
    localStorage.setItem('drey.tasks', JSON.stringify({ scope: 'galaxy', kinds: ['bogus'] }));
    const prefs = readPrefs();
    expect(prefs.scope).toBe('document');
    expect(prefs.kinds).toEqual(['checkbox', 'tag']);
  });

  it('keeps an empty kind selection from hiding everything', () => {
    localStorage.setItem('drey.tasks', JSON.stringify({ kinds: [] }));
    expect(readPrefs().kinds).toEqual(['checkbox', 'tag']);
  });
});
