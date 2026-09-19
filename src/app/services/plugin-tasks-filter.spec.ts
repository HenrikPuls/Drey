import {
  filterVisibleTasks,
  normalizeTag,
  readPrefs,
  writePrefs,
  type TaskFilter,
} from '../../../plugins/tasks/renderer/filter';
import type { TaskRecord } from '../../../plugins/tasks/shared/tasks';

/**
 * The Tasks plugin's panel filter + persisted preferences
 * (`plugins/tasks/renderer/filter`), relocated from the old
 * `TaskService` spec at the ADR-0044 stage-6 conversion: the ng test
 * runner ignores `plugins/**`, so the spec lives here.
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
  },
];

const NO_FILTER: TaskFilter = {
  kinds: ['checkbox', 'tag'],
  hideDone: false,
  queryTags: [],
  queryText: '',
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
    });
  });

  it('round-trips through writePrefs (same key + shape as before the conversion)', () => {
    writePrefs({
      scope: 'vault',
      hideDone: true,
      kinds: ['checkbox'],
      queryTags: ['project'],
      queryText: 'brief',
    });
    expect(readPrefs()).toEqual({
      scope: 'vault',
      hideDone: true,
      kinds: ['checkbox'],
      queryTags: ['project'],
      queryText: 'brief',
    });
  });

  it('persists the all-vaults scope (milestone 34)', () => {
    writePrefs({
      scope: 'all',
      hideDone: false,
      kinds: ['checkbox', 'tag'],
      queryTags: [],
      queryText: '',
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
