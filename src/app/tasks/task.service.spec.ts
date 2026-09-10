import { TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import type { TaskRecord } from '../../../shared/tasks';
import { TaskService } from './task.service';

/** Vault-scope tasks the fake `tasks:list` returns. */
const VAULT_TASKS: TaskRecord[] = [
  { path: 'a.md', line: 3, text: 'draft the brief', done: false, kind: 'checkbox', heading: 'Projekt Alpha', tags: ['project', 'project/frontend'] },
  { path: 'a.md', line: 4, text: 'send the invoice', done: true, kind: 'checkbox', heading: 'Projekt Alpha', tags: ['project', 'buchhaltung'] },
  { path: 'b.md', line: 9, text: 'call the landlord', done: false, kind: 'tag', heading: 'Wohnung', tags: ['wohnung'] },
  { path: 'b.md', line: 12, text: 'water the plants', done: false, kind: 'checkbox', heading: null, tags: [] },
];

describe('TaskService filter (req-8)', () => {
  let service: TaskService;

  beforeEach(async () => {
    localStorage.removeItem('drey.tasks');
    window.dreyApi = {
      listTasks: () => Promise.resolve(VAULT_TASKS),
    } as unknown as DreyApi;
    service = TestBed.inject(TaskService);
    await service.refresh();
    service.setScope('vault');
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.tasks');
  });

  it('shows everything with no filter', () => {
    expect(service.visible().map((t) => t.text)).toEqual([
      'draft the brief',
      'send the invoice',
      'call the landlord',
      'water the plants',
    ]);
  });

  it('filters by a section tag (AND across tags)', () => {
    service.addTag('#project');
    expect(service.visible().map((t) => t.text)).toEqual(['draft the brief', 'send the invoice']);

    service.addTag('buchhaltung');
    expect(service.visible().map((t) => t.text)).toEqual(['send the invoice']);
  });

  it('matches a parent tag against a nested section tag', () => {
    // Only a.md line 3 carries `project/frontend`.
    service.addTag('project/frontend');
    expect(service.visible().map((t) => t.text)).toEqual(['draft the brief']);
  });

  it('filters by free text (AND across whitespace terms, over text + heading)', () => {
    service.setText('landlord');
    expect(service.visible().map((t) => t.text)).toEqual(['call the landlord']);

    service.setText('the wohnung');
    expect(service.visible().map((t) => t.text)).toEqual(['call the landlord']);
  });

  it('combines tag and text filters', () => {
    service.addTag('project');
    service.setText('invoice');
    expect(service.visible().map((t) => t.text)).toEqual(['send the invoice']);
  });

  it('persists the filter and clearFilter empties it', () => {
    service.addTag('project');
    service.setText('brief');
    TestBed.tick(); // flush the persist effect
    expect(JSON.parse(localStorage.getItem('drey.tasks')!)).toMatchObject({
      queryTags: ['project'],
      queryText: 'brief',
    });

    service.clearFilter();
    expect(service.hasFilter()).toBe(false);
    expect(service.visible().length).toBe(4);
  });
});
