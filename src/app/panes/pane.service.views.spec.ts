import { TestBed } from '@angular/core/testing';
import { PaneService } from './pane.service';

describe('PaneService views (ADR-0089)', () => {
  let panes: PaneService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    panes = TestBed.inject(PaneService);
  });

  it('keeps a layout per view: tabs of the other view are hidden, and come back as left', () => {
    panes.open('a.md');
    panes.splitPane('p1', 'row');
    panes.open('b.md');
    const notesTree = panes.root();

    panes.switchView('work');
    expect(panes.activeViewId()).toBe('work');
    expect(panes.paneIds().length).toBe(1);
    expect(panes.focusedPane()!.tabs).toEqual([]);
    panes.open('t.md');

    panes.switchView('notes');
    expect(panes.root()).toBe(notesTree);
    expect(panes.focusedPane()!.tabs).toEqual(['b.md']);
    expect(panes.paneIdFor('t.md')).toBeNull();
  });

  it('never repeats a pane id across views', () => {
    panes.switchView('work');
    panes.splitPane(panes.focusedId(), 'row');
    const work = panes.paneIds();
    panes.switchView('notes');
    for (const id of panes.paneIds()) {
      expect(work).not.toContain(id);
    }
  });

  it('shows one document in several views and reports where it is held', () => {
    panes.open('a.md');
    panes.showInView('work', 'a.md');
    expect(panes.viewsHolding('a.md').sort()).toEqual(['notes', 'work']);
    expect(panes.tabsOfView('work')).toEqual(['a.md']);

    panes.hideInView('work', 'a.md');
    expect(panes.viewsHolding('a.md')).toEqual(['notes']);
    expect(panes.allTabKeys()).toEqual(new Set(['a.md']));
  });

  it('closes in the active view only, or everywhere', () => {
    panes.open('a.md');
    panes.showInView('work', 'a.md');
    panes.closeInActiveView('a.md');
    expect(panes.viewsHolding('a.md')).toEqual(['work']);

    panes.closeEverywhere('a.md');
    expect(panes.viewsHolding('a.md')).toEqual([]);
  });

  it('follows a rename into the other views', () => {
    panes.open('a.md');
    panes.showInView('work', 'a.md');
    panes.renamePath('a.md', 'b.md');
    expect(panes.tabsOfView('work')).toEqual(['b.md']);
  });

  it('copies the active layout under fresh ids for "Save current layout as a view"', () => {
    panes.open('a.md');
    panes.splitPane('p1', 'row', 'a.md');
    panes.cloneActiveViewTo('mine');
    panes.switchView('mine');
    expect(panes.allTabKeys()).toEqual(new Set(['a.md']));
    expect(panes.paneIds().length).toBe(2);
    expect(panes.paneIds()).not.toContain('p1');
    expect(panes.viewsHolding('a.md').sort()).toEqual(['mine', 'notes']);
  });

  it('drops a view', () => {
    panes.showInView('work', 'a.md');
    panes.dropView('work');
    expect(panes.viewsHolding('a.md')).toEqual([]);
  });

  it('snapshots and restores the other views, pruning tabs that did not come back', () => {
    panes.open('a.md');
    panes.showInView('work', 'w.md');
    panes.showInView('work', 'gone.md');
    const snaps = panes.snapshotOtherViews();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const fresh = TestBed.inject(PaneService);
    fresh.restoreOtherViews(snaps, (p) => p !== 'gone.md');
    expect(fresh.tabsOfView('work')).toEqual(['w.md']);
    fresh.switchView('work');
    expect(fresh.focusedPane()!.tabs).toEqual(['w.md']);
  });

  it('restores an empty active view to the default pane', () => {
    const restored = panes.restore(
      { root: { kind: 'leaf', paneId: 'p1' }, panes: { p1: { id: 'p1', tabs: [], active: null } }, focusedId: 'p1' },
      () => true,
    );
    expect(restored).toBe(false);
    expect(panes.paneIds()).toEqual(['p1']);
  });
});
