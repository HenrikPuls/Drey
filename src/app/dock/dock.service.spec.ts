import { TestBed } from '@angular/core/testing';
import { PaneService } from '../panes/pane.service';
import { SettingsService } from '../services/settings.service';
import { DockService } from './dock.service';
import { CORE_WIDGETS } from './widget-registry';

describe('DockService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
  });

  function make(): DockService {
    return TestBed.inject(DockService);
  }

  it('starts from the registry defaults', () => {
    const dock = make();
    const idsOn = (side: 'left' | 'right' | 'bottom') =>
      CORE_WIDGETS.filter((w) => w.defaultDock === side).map((w) => w.id);
    expect(dock.leftIds()).toEqual(idsOn('left'));
    expect(dock.rightIds()).toEqual(idsOn('right'));
    expect(dock.bottomIds()).toEqual(idsOn('bottom'));
    for (const w of CORE_WIDGETS) {
      expect(dock.closed(w.id)).toBe(!w.defaultOpen);
    }
    expect(dock.dockWidth('left')).toBe(248);
    expect(dock.dockWidth('right')).toBe(340);
    expect(dock.dockHeight()).toBe(280);
  });

  describe('folding a side dock (the titlebar toggles)', () => {
    it('folds and unfolds a side, keeping its panels, and persists it', () => {
      const dock = make();
      const before = dock.leftIds();
      expect(dock.sideFolded('left')).toBe(false);

      dock.toggleSide('left');
      expect(dock.sideFolded('left')).toBe(true);
      expect(dock.sideFolded('right')).toBe(false);
      expect(dock.leftIds()).toEqual(before);
      expect(JSON.parse(localStorage.getItem('drey.dock')!).foldedSides).toEqual(['left']);

      dock.toggleSide('left');
      expect(dock.sideFolded('left')).toBe(false);
    });

    it('restores the folded sides from storage and ignores junk', () => {
      localStorage.setItem('drey.dock', JSON.stringify({ foldedSides: ['right', 'bottom', 7] }));
      const dock = make();
      expect(dock.sideFolded('right')).toBe(true);
      expect(dock.sideFolded('left')).toBe(false);
      expect(dock.sideFolded('bottom')).toBe(false);
    });

    it('revealing a panel unfolds the dock it sits in', () => {
      const dock = make();
      dock.toggleSide('left');
      dock.openAndExpand('files');
      expect(dock.sideFolded('left')).toBe(false);
    });

    it('a drop into a folded dock keeps it open; reset unfolds everything', () => {
      const dock = make();
      dock.toggleSide('right');
      dock.move('calendar', 'right', 0);
      expect(dock.sideFolded('right')).toBe(false);

      dock.toggleSide('left');
      dock.reset();
      expect(dock.sideFolded('left')).toBe(false);
    });
  });

  it('moves a panel into the bottom dock and clamps its height', () => {
    const dock = make();
    dock.move('calendar', 'bottom', 0);
    expect(dock.bottomIds()).toEqual(['calendar']);
    expect(dock.leftIds()).toEqual(['files', 'windows']);
    dock.setBottomHeight(10);
    expect(dock.dockHeight()).toBe(140);
    dock.setBottomHeight(9000);
    expect(dock.dockHeight()).toBe(680);
  });

  it('drops widget ids the registry no longer knows from a stored blob (the removed entry panel)', () => {
    localStorage.setItem(
      'drey.dock',
      JSON.stringify({
        // `assistant` is a plugin widget id now (ADR-0044) -- unknown to the
        // core registry, so it folds out of the stored blob.
        dock: {
          left: ['calendar', 'files', 'search', 'windows'],
          right: ['assistant'],
          bottom: ['entry'],
        },
      }),
    );
    const dock = make();
    expect(dock.bottomIds()).toEqual([]);
    expect(dock.rightIds()).toEqual([]);
    expect(dock.leftIds()).toEqual(['calendar', 'files', 'windows']);
  });

  it('promotes a header press to a drag only past the movement threshold', () => {
    const dock = make();
    expect(dock.dragActive()).toBe(false);
    dock.beginHeaderPress('calendar', 'Calendar', new MouseEvent('mousedown', { button: 0 }));
    // A tiny jitter is still a click, not a drag.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 2, clientY: 1 }));
    expect(dock.dragActive()).toBe(false);
    // Past the threshold it becomes a drag.
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 30 }));
    expect(dock.dragActive()).toBe(true);
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(dock.dragActive()).toBe(false);
  });

  describe('editor band drag (ADR-0038)', () => {
    it('promotes past the threshold and focuses the pane on a plain click', () => {
      const dock = make();
      const panes = TestBed.inject(PaneService);
      panes.open('a.md');
      panes.detachToDock('p1', 'right');

      dock.beginEditorBandPress('p1', 'a.md', new MouseEvent('mousedown', { button: 0 }));
      panes.focus('p2'); // the centre placeholder -- a click must pull focus back
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(dock.dragActive()).toBe(false);
      expect(panes.focusedId()).toBe('p1');
    });

    it('carries the editor payload and never shows a widget drop index', () => {
      const dock = make();
      const panes = TestBed.inject(PaneService);
      panes.open('a.md');
      panes.detachToDock('p1', 'right');

      dock.beginEditorBandPress('p1', 'a.md', new MouseEvent('mousedown', { button: 0 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 30 }));
      expect(dock.dragActive()).toBe(true);
      expect(dock.dropDock()).not.toBeNull();
      expect(dock.dropIndex()).toBeNull(); // no widget drop-lines during an editor drag
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(dock.dragActive()).toBe(false);
    });

    it('re-docks to the target side on drop', () => {
      const dock = make();
      const panes = TestBed.inject(PaneService);
      panes.open('a.md');
      panes.detachToDock('p1', 'right');

      dock.beginEditorBandPress('p1', 'a.md', new MouseEvent('mousedown', { button: 0 }));
      // Simulate the move/end pair over the left dock's registered element.
      const leftEl = document.createElement('div');
      Object.defineProperty(leftEl, 'getBoundingClientRect', {
        value: () => ({ left: 0, right: 200, top: 0, bottom: 800, width: 200, height: 800 }),
      });
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 30 }));
      dock.registerDockEl('left', leftEl);
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 30 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(panes.dockPane('left')).toBe('p1');
      expect(panes.dockPane('right')).toBeNull();
    });

    it('reattaches to the centre on a centre drop', () => {
      const dock = make();
      const panes = TestBed.inject(PaneService);
      panes.open('a.md');
      panes.detachToDock('p1', 'right');

      dock.beginEditorBandPress('p1', 'a.md', new MouseEvent('mousedown', { button: 0 }));
      // No dock element covers the pointer -- the editor fallback is 'center'.
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 30 }));
      expect(dock.dropDock()).toBe('center');
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(panes.dockPane('right')).toBeNull();
      expect(panes.regionOf('p1')).toBe('center');
    });
  });

  it('treats a header press with no movement as a toggle', () => {
    const dock = make();
    expect(dock.closed('calendar')).toBe(false);
    dock.beginHeaderPress('calendar', 'Calendar', new MouseEvent('mousedown', { button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(dock.closed('calendar')).toBe(true);
    expect(dock.dragActive()).toBe(false);
  });

  describe('toggle (strip icon / header click / View menu)', () => {
    it('closes and reopens a panel, which keeps its dock slot', () => {
      const dock = make();
      dock.toggle('files');
      expect(dock.closed('files')).toBe(true);
      expect(dock.leftIds()).toEqual(['calendar', 'files', 'windows']);
      dock.toggle('files');
      expect(dock.closed('files')).toBe(false);
    });

    it('closing the last open panel of a side dock folds the dock away', () => {
      const dock = make();
      dock.toggle('calendar');
      dock.toggle('files');
      expect(dock.sideFolded('left')).toBe(false);
      dock.toggle('windows');
      expect(dock.noneOpen('left')).toBe(true);
      expect(dock.sideFolded('left')).toBe(true);
    });

    it('opening a panel unfolds its dock', () => {
      const dock = make();
      for (const id of ['calendar', 'files', 'windows']) {
        dock.toggle(id);
      }
      dock.toggle('files');
      expect(dock.sideFolded('left')).toBe(false);
      expect(dock.closed('files')).toBe(false);
    });

    it('a side dock holding an editor band stays when its last panel closes', () => {
      const dock = make();
      const panes = TestBed.inject(PaneService);
      panes.open('a.md');
      panes.detachToDock('p1', 'left');
      for (const id of ['calendar', 'files', 'windows']) {
        dock.toggle(id);
      }
      expect(dock.sideFolded('left')).toBe(false);
    });

    it('the bottom dock never folds -- it just reports nothing open', () => {
      const dock = make();
      dock.move('windows', 'bottom', 0);
      dock.toggle('windows');
      expect(dock.noneOpen('bottom')).toBe(true);
      expect(dock.sideFolded('bottom')).toBe(false);
    });

    it('a closed panel can be moved to another dock and stays closed', () => {
      const dock = make();
      dock.toggle('windows');
      dock.move('windows', 'right', 0);
      expect(dock.rightIds()).toEqual(['windows']);
      expect(dock.closed('windows')).toBe(true);
    });

    it('round-trips the open state through persistence', () => {
      const first = make();
      first.toggle('files');

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      const second = TestBed.inject(DockService);
      expect(second.closed('files')).toBe(true);
      expect(second.leftIds()).toEqual(['calendar', 'files', 'windows']);
    });
  });

  describe('a panel drag over the icon strip', () => {
    function rectEl(left: number, top: number, width: number, height: number): HTMLElement {
      const el = document.createElement('div');
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
      });
      return el;
    }

    it('takes the drop slot from the icons under the pointer', () => {
      const dock = make();
      dock.registerDockEl('left', rectEl(0, 0, 248, 800));
      dock.registerStripEl('calendar', rectEl(8, 4, 24, 24));
      dock.registerStripEl('files', rectEl(34, 4, 24, 24));
      dock.registerStripEl('windows', rectEl(60, 4, 24, 24));

      dock.beginHeaderPress('windows', 'Open windows', new MouseEvent('mousedown', { button: 0 }));
      // Left half of the `files` icon: the slot before it.
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 16 }));
      expect(dock.dropDock()).toBe('left');
      expect(dock.dropIndex()).toBe(1);
      // Past the last icon: the end of the row.
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: 16 }));
      expect(dock.dropIndex()).toBe(3);
      // Below the strip the panel stack decides; with no open panel box
      // registered that is the end of the list.
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 300 }));
      expect(dock.dropIndex()).toBe(3);

      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 16 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
      expect(dock.leftIds()).toEqual(['windows', 'calendar', 'files']);
    });

    it('skips a closed panel (no box) when the stack decides the slot', () => {
      const dock = make();
      dock.registerDockEl('left', rectEl(0, 0, 248, 800));
      dock.registerPanelEl('calendar', rectEl(0, 0, 0, 0)); // closed: display none
      dock.registerPanelEl('files', rectEl(0, 100, 248, 200));
      dock.registerPanelEl('windows', rectEl(0, 300, 248, 200));

      dock.beginHeaderPress('windows', 'Open windows', new MouseEvent('mousedown', { button: 0 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 120 }));
      expect(dock.dropIndex()).toBe(1); // before `files`, not before the boxless `calendar`
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
  });

  it('nextOpenId skips closed neighbours and stops at the end', () => {
    const dock = make();
    // left: [calendar, files, windows]
    expect(dock.nextOpenId('calendar')).toBe('files');
    expect(dock.nextOpenId('files')).toBe('windows');
    expect(dock.nextOpenId('windows')).toBeNull(); // last open panel
    dock.toggle('files');
    expect(dock.nextOpenId('calendar')).toBe('windows');
  });

  it('moves a panel across docks at the requested slot', () => {
    const dock = make();
    dock.move('calendar', 'right', 0);
    expect(dock.leftIds()).toEqual(['files', 'windows']);
    expect(dock.rightIds()).toEqual(['calendar']);
  });

  it('reorders within a dock (drop-line index is pre-removal)', () => {
    const dock = make();
    // Move `calendar` to sit after `files`: visual slot 2 in the original list.
    dock.move('calendar', 'left', 2);
    expect(dock.leftIds()).toEqual([
      'files',
      'calendar',
      'windows',
    ]);
  });

  it('clamps dock width to 180..560', () => {
    const dock = make();
    dock.setDockWidth('left', 40);
    expect(dock.dockWidth('left')).toBe(180);
    dock.setDockWidth('left', 9000);
    expect(dock.dockWidth('left')).toBe(560);
  });

  it('openAndExpand opens a closed docked panel', () => {
    const dock = make();
    dock.move('windows', 'bottom', 0);
    dock.toggle('windows');
    expect(dock.closed('windows')).toBe(true);
    dock.openAndExpand('windows');
    expect(dock.closed('windows')).toBe(false);
    expect(dock.sideOf('windows')).toBe('bottom');
  });

  it('reset restores every default', () => {
    const dock = make();
    dock.move('calendar', 'right', 0);
    dock.toggle('files');
    dock.setDockWidth('left', 500);
    dock.reset();
    expect(dock.leftIds()).toEqual([
      'calendar',
      'files',
      'windows',
    ]);
    expect(dock.closed('files')).toBe(false);
    expect(dock.dockWidth('left')).toBe(248);
  });

  it('persists across instances and folds a partial blob onto the defaults', () => {
    const first = make();
    first.move('calendar', 'right', 0);
    first.setDockWidth('right', 400);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const second = TestBed.inject(DockService);
    expect(second.rightIds()).toEqual(['calendar']);
    expect(second.dockWidth('right')).toBe(400);
  });

  it('ignores a corrupt stored blob', () => {
    localStorage.setItem('drey.dock', '{ not json');
    const dock = make();
    expect(dock.leftIds()).toEqual([
      'calendar',
      'files',
      'windows',
    ]);
  });

  it('re-places a panel missing from a stored blob', () => {
    localStorage.setItem(
      'drey.dock',
      JSON.stringify({ dock: { left: ['calendar', 'files'], right: [] } }),
    );
    const dock = make();
    // windows (left by default) comes back; the right dock stays empty
    // (its default resident, `assistant`, is a plugin widget now).
    expect(dock.leftIds()).toEqual([
      'calendar',
      'files',
      'windows',
    ]);
    expect(dock.rightIds()).toEqual([]);
  });

  describe('a layout stored before the icon strip', () => {
    it('keeps a collapsed panel in its slot, closed', () => {
      localStorage.setItem(
        'drey.dock',
        JSON.stringify({
          dock: { left: ['calendar', 'files', 'windows'], right: [], bottom: [] },
          open: { calendar: true, files: false, windows: true },
          hidden: [],
        }),
      );
      const dock = make();
      expect(dock.leftIds()).toEqual(['calendar', 'files', 'windows']);
      expect(dock.closed('files')).toBe(true);
      expect(dock.closed('windows')).toBe(false);
    });

    it('re-homes a View-menu-hidden widget to its default dock, closed', () => {
      localStorage.setItem(
        'drey.dock',
        JSON.stringify({
          dock: { left: ['calendar', 'windows'], right: [], bottom: [] },
          open: { calendar: true, files: true, windows: true },
          hidden: ['files'],
        }),
      );
      const dock = make();
      expect(dock.leftIds()).toEqual(['calendar', 'files', 'windows']);
      expect(dock.closed('files')).toBe(true);
      // The old list is not written back.
      dock.toggle('files');
      expect(JSON.parse(localStorage.getItem('drey.dock')!).hidden).toBeUndefined();
    });
  });

  describe('reconcileEnabled (Settings -> Widgets)', () => {
    it('drops a disabled widget from its dock', () => {
      const dock = make();
      dock.reconcileEnabled(new Set(['files', 'windows']));
      expect(dock.leftIds()).toEqual(['calendar']);
      expect(dock.sideOf('files')).toBeNull();
      expect(dock.sideOf('windows')).toBeNull();
    });

    it('also drops a disabled widget that was closed', () => {
      const dock = make();
      dock.toggle('files');
      dock.reconcileEnabled(new Set(['files']));
      expect(dock.sideOf('files')).toBeNull();
    });

    it('re-homes a widget that is enabled again and now nowhere', () => {
      const dock = make();
      dock.reconcileEnabled(new Set(['windows']));
      expect(dock.leftIds()).not.toContain('windows');
      dock.reconcileEnabled(new Set());
      expect(dock.leftIds()).toEqual(['calendar', 'files', 'windows']);
    });

    it('is a no-op when nothing is disabled', () => {
      const dock = make();
      const before = JSON.stringify(localStorage.getItem('drey.dock'));
      dock.reconcileEnabled(new Set());
      expect(JSON.stringify(localStorage.getItem('drey.dock'))).toBe(before);
    });
  });

  describe('a widget disabled in the persisted config', () => {
    // Regression: the registry-absorb effect re-placed a disabled widget and
    // the reconcile effect removed it again, forever -- the renderer froze
    // and ate memory on every start once any widget was switched off.
    it('settles instead of ping-ponging between the two effects', () => {
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      TestBed.configureTestingModule({
        providers: [{ provide: SettingsService, useValue: { widgetsDisabled: () => new Set(['files']) } }],
      });
      const dock = make();
      for (let i = 0; i < 5; i++) {
        TestBed.tick();
      }
      expect(dock.sideOf('files')).toBeNull();
      expect(dock.leftIds()).toEqual(['calendar', 'windows']);
      expect(setItem.mock.calls.length).toBeLessThan(10);
    });
  });
});
