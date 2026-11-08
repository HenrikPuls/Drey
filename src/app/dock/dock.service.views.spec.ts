import { TestBed } from '@angular/core/testing';
import { DockService } from './dock.service';
import { WidgetRegistryService } from './widget-registry.service';

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

  it('seeds a preset\'s bottom height, clamped like a resize, once (SDK 1.51)', () => {
    const dock = TestBed.inject(DockService);
    dock.seedView('plain', { bottom: [] });
    dock.seedView('band', { bottom: [], bottomH: 103.4 });
    dock.seedView('low', { bottom: [], bottomH: 20 });
    dock.seedView('high', { bottom: [], bottomH: 5000 });
    const plainDefault = dock.dockHeight();

    dock.switchView('plain');
    expect(dock.dockHeight()).toBe(plainDefault);
    dock.switchView('band');
    expect(dock.dockHeight()).toBe(103);
    dock.switchView('low');
    expect(dock.dockHeight()).toBe(100);
    dock.switchView('high');
    expect(dock.dockHeight()).toBe(680);

    // Afterwards the user's height is the truth: a second seed changes nothing.
    dock.switchView('band');
    dock.setBottomHeight(200);
    dock.switchView('notes');
    dock.seedView('band', { bottom: [], bottomH: 103 });
    dock.switchView('band');
    expect(dock.dockHeight()).toBe(200);
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

  it('maps a replaced panel\'s old ids to the panel that took over, once (SDK 1.54)', () => {
    const stored = {
      active: 'notes',
      views: {
        notes: {
          dock: { left: ['files', 'search', 'tasks'], right: ['assistant'], bottom: [] },
          flexes: { search: 333 },
          open: { files: true, search: true, tasks: false },
          collapsed: {},
        },
      },
    };
    localStorage.setItem('drey.dock', JSON.stringify(stored));
    const registry = TestBed.inject(WidgetRegistryService);
    registry.registerPluginWidget({
      id: 'find',
      title: 'Find',
      aliases: ['search', 'tasks'],
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 260,
      mount: () => () => undefined,
    });
    const dock = TestBed.inject(DockService);
    TestBed.tick();
    expect(dock.idsFor('left').filter((id) => ['files', 'find', 'search', 'tasks'].includes(id))).toEqual(['files', 'find']);
    expect(dock.closed('find')).toBe(false);

    const persisted = JSON.parse(localStorage.getItem('drey.dock')!);
    expect(persisted.views.notes.dock.left).toContain('find');
    expect(JSON.stringify(persisted)).not.toContain('"search"');
    expect(JSON.stringify(persisted)).not.toContain('"tasks"');
  });
});
