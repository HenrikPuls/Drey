import { TestBed } from '@angular/core/testing';
import type { DreyApi } from '../../../shared/ipc-api';
import { DockService } from '../dock';
import { PaneService } from '../panes';
import { EditorService } from '../services/editor.service';
import { ViewService } from './view.service';

describe('ViewService', () => {
  let views: ViewService;
  let editor: EditorService;
  let panes: PaneService;
  let dock: DockService;

  beforeEach(() => {
    localStorage.clear();
    window.dreyApi = {
      readVaultFile: (p: string) => Promise.resolve({ content: `body of ${p}`, modifiedMs: 1 }),
    } as unknown as DreyApi;
    views = TestBed.inject(ViewService);
    editor = TestBed.inject(EditorService);
    panes = TestBed.inject(PaneService);
    dock = TestBed.inject(DockService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.clear();
  });

  it('starts with Notes only, active', () => {
    expect(views.views().map((v) => v.label)).toEqual(['Notes']);
    expect(views.activeId()).toBe('notes');
  });

  it('saves the current layout as a view, switches to it and persists the list', async () => {
    await editor.openFile('a.md');
    dock.setDockWidth('left', 300);
    const id = views.saveCurrentAs('  Review  ');

    expect(views.activeId()).toBe(id);
    expect(views.active().label).toBe('Review');
    expect(dock.dockWidth('left')).toBe(300);
    expect(panes.tabsOfView(id)).toEqual(['a.md']); // the same document, shown here too
    expect(editor.openDocs().length).toBe(1); // ...but one document, one buffer
    expect(JSON.parse(localStorage.getItem('drey.views')!).views).toEqual([
      { id, label: 'Review', builtin: false },
    ]);
  });

  it('gives every view its own tabs: a tab opened in one is hidden in the other', async () => {
    await editor.openFile('a.md');
    const id = views.saveCurrentAs('Second');
    await editor.openFile('b.md', undefined, { keepFocused: true });
    expect(panes.tabsOfView(id)).toEqual(['a.md', 'b.md']);

    views.switchTo('notes');
    expect(panes.tabsOfView('notes')).toEqual(['a.md']);
    expect(editor.activePath()).toBe('a.md');
    expect(editor.openDocs().map((d) => d.key)).toEqual(['a.md', 'b.md']);
  });

  it('switches by index and to the next view, wrapping around', () => {
    const second = views.saveCurrentAs('Second');
    views.switchToIndex(0);
    expect(views.activeId()).toBe('notes');
    views.switchToIndex(5); // no such view: nothing happens
    expect(views.activeId()).toBe('notes');
    views.switchToNext();
    expect(views.activeId()).toBe(second);
    views.switchToNext();
    expect(views.activeId()).toBe('notes');
  });

  it('closing a tab removes it from this view only while another view shows it', async () => {
    await editor.openFile('a.md');
    const second = views.saveCurrentAs('Second');
    expect(await editor.closeTab('a.md')).toBe(true);

    expect(panes.tabsOfView(second)).toEqual([]);
    expect(panes.tabsOfView('notes')).toEqual(['a.md']);
    expect(editor.docFor('a.md')).not.toBeNull(); // still open in Notes
    views.switchTo('notes');
    expect(await editor.closeTab('a.md')).toBe(true);
    expect(editor.docFor('a.md')).toBeNull(); // the last view let go: closed for good
  });

  it('"Show this tab in" ticks a view on and off, but never the last one', async () => {
    await editor.openFile('a.md');
    const second = views.saveCurrentAs('Second');
    views.switchTo('notes');
    await editor.openFile('n.md');

    views.toggleTabIn('n.md', second);
    expect(views.viewsOfTab('n.md').sort()).toEqual(['notes', second].sort());
    views.toggleTabIn('n.md', 'notes');
    expect(views.viewsOfTab('n.md')).toEqual([second]);
    views.toggleTabIn('n.md', second); // the last view: stays
    expect(views.viewsOfTab('n.md')).toEqual([second]);
  });

  it('"Show here" brings a document of another view into the active one', async () => {
    const second = views.saveCurrentAs('Second');
    await editor.openFile('only-second.md');
    views.switchTo('notes');
    expect(panes.tabsOfView('notes')).toEqual([]);

    views.showHere('only-second.md');
    expect(panes.tabsOfView('notes')).toEqual(['only-second.md']);
    expect(views.viewsOfTab('only-second.md').sort()).toEqual(['notes', second].sort());
  });

  it('opening a file already open in another view adds it to the active view', async () => {
    const second = views.saveCurrentAs('Second');
    await editor.openFile('x.md');
    views.switchTo('notes');
    await editor.openFile('x.md');
    expect(panes.tabsOfView('notes')).toEqual(['x.md']);
    expect(editor.openDocs().length).toBe(1);
    expect(views.viewsOfTab('x.md')).toContain(second);
  });

  it('a delete of the file closes its tab in every view', async () => {
    await editor.openFile('a.md');
    const second = views.saveCurrentAs('Second');
    editor.closeTabsUnder(null, 'a.md');
    expect(panes.viewsHolding('a.md')).toEqual([]);
    expect(panes.tabsOfView(second)).toEqual([]);
  });

  it('renames a user view but never Notes; refuses a taken name', () => {
    const id = views.saveCurrentAs('Second');
    views.rename(id, 'Renamed');
    expect(views.active().label).toBe('Renamed');
    views.rename('notes', 'Nope');
    expect(views.views()[0].label).toBe('Notes');
    expect(views.labelTaken('notes')).toBe(true);
    expect(views.labelTaken('Renamed', id)).toBe(false);
  });

  it('the name field saves a view, rejects an empty or used name', () => {
    views.openSavePrompt();
    expect(views.commitPrompt('   ')).toBe(false);
    expect(views.commitPrompt('Notes')).toBe(false);
    expect(views.prompt()).not.toBeNull();
    expect(views.commitPrompt('Work')).toBe(true);
    expect(views.prompt()).toBeNull();
    expect(views.views().map((v) => v.label)).toEqual(['Notes', 'Work']);
  });

  it('deletes a user view: Notes becomes active, its own documents close, shared ones stay', async () => {
    await editor.openFile('shared.md');
    const second = views.saveCurrentAs('Second');
    await editor.openFile('mine.md');

    await views.remove(second);

    expect(views.activeId()).toBe('notes');
    expect(views.views().map((v) => v.label)).toEqual(['Notes']);
    expect(editor.docFor('mine.md')).toBeNull();
    expect(editor.docFor('shared.md')).not.toBeNull();
    expect(panes.tabsOfView('notes')).toEqual(['shared.md']);
  });

  it('cannot delete Notes', async () => {
    await views.remove('notes');
    expect(views.views().length).toBe(1);
  });

  it('reads the saved list back and falls back to Notes for an active view that no longer exists', () => {
    const id = views.saveCurrentAs('Second');
    expect(JSON.parse(localStorage.getItem('drey.dock')!).active).toBe(id);

    TestBed.resetTestingModule();
    localStorage.setItem('drey.views', JSON.stringify({ views: [] })); // the view was deleted elsewhere
    const again = TestBed.inject(ViewService);
    expect(again.views().map((v) => v.label)).toEqual(['Notes']);
    expect(again.activeId()).toBe('notes');
    expect(TestBed.inject(DockService).activeViewId()).toBe('notes');
  });
});
