import { TestBed } from '@angular/core/testing';
import { DockService } from './dock.service';

describe('DockService views (ADR-0089)', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
  });

  it('keeps one dock layout per view and restores it on switching back', () => {
    const dock = TestBed.inject(DockService);
    dock.toggleSide('left');
    dock.setDockWidth('left', 300);

    dock.switchView('work');
    expect(dock.activeViewId()).toBe('work');
    expect(dock.sideFolded('left')).toBe(false); // a view without a layout starts at the defaults
    expect(dock.dockWidth('left')).toBe(248);
    dock.setDockWidth('left', 400);

    dock.switchView('notes');
    expect(dock.sideFolded('left')).toBe(true);
    expect(dock.dockWidth('left')).toBe(300);
    dock.switchView('work');
    expect(dock.dockWidth('left')).toBe(400);
  });

  it('copies the active layout to a new view and drops a deleted one', () => {
    const dock = TestBed.inject(DockService);
    dock.setDockWidth('right', 420);
    dock.copyActiveTo('mine');
    dock.setDockWidth('right', 200);

    dock.switchView('mine');
    expect(dock.dockWidth('right')).toBe(420);
    dock.switchView('notes');
    dock.dropView('mine');
    dock.switchView('mine'); // gone: back to the defaults
    expect(dock.dockWidth('right')).toBe(340);
  });

  it('persists every view and the active one, and reads them back', () => {
    const dock = TestBed.inject(DockService);
    dock.setDockWidth('left', 300);
    dock.switchView('work');
    dock.setDockWidth('left', 410);

    const stored = JSON.parse(localStorage.getItem('drey.dock')!);
    expect(stored.active).toBe('work');
    expect(stored.views.notes.leftW).toBe(300);
    expect(stored.views.work.leftW).toBe(410);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const again = TestBed.inject(DockService);
    expect(again.activeViewId()).toBe('work');
    expect(again.dockWidth('left')).toBe(410);
    again.switchView('notes');
    expect(again.dockWidth('left')).toBe(300);
  });

  it('reads a layout stored before views as the Notes view', () => {
    localStorage.setItem('drey.dock', JSON.stringify({ leftW: 333 }));
    const dock = TestBed.inject(DockService);
    expect(dock.activeViewId()).toBe('notes');
    expect(dock.dockWidth('left')).toBe(333);
  });

  it('"Reset layout" resets the active view only', () => {
    const dock = TestBed.inject(DockService);
    dock.setDockWidth('left', 300);
    dock.switchView('work');
    dock.setDockWidth('left', 410);
    dock.reset();
    expect(dock.dockWidth('left')).toBe(248);
    dock.switchView('notes');
    expect(dock.dockWidth('left')).toBe(300);
  });
});
