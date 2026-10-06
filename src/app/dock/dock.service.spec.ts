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
      expect(dock.collapsed(w.id)).toBe(!w.defaultOpen);
      expect(dock.isHidden(w.id)).toBe(false);
    }
    expect(dock.dockWidth('left')).toBe(248);
    expect(dock.dockWidth('right')).toBe(340);
    expect(dock.dockHeight()).toBe(280);
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

  it('treats a header press with no movement as a collapse toggle', () => {
    const dock = make();
    expect(dock.collapsed('calendar')).toBe(false);
    dock.beginHeaderPress('calendar', 'Calendar', new MouseEvent('mousedown', { button: 0 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    expect(dock.collapsed('calendar')).toBe(true);
    expect(dock.dragActive()).toBe(false);
  });

  it('toggles collapse', () => {
    const dock = make();
    dock.toggleCollapse('calendar');
    expect(dock.collapsed('calendar')).toBe(true);
    dock.toggleCollapse('calendar');
    expect(dock.collapsed('calendar')).toBe(false);
  });

  it('nextOpenId skips collapsed neighbours and stops at the end', () => {
    const dock = make();
    // left: [calendar, files, windows]; entry sits collapsed in the bottom dock.
    expect(dock.nextOpenId('calendar')).toBe('files');
    expect(dock.nextOpenId('files')).toBe('windows');
    expect(dock.nextOpenId('windows')).toBeNull(); // last open panel
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

  it('openAndExpand expands a collapsed docked panel', () => {
    const dock = make();
    dock.move('windows', 'bottom', 0);
    dock.toggleCollapse('windows');
    expect(dock.collapsed('windows')).toBe(true);
    dock.openAndExpand('windows');
    expect(dock.collapsed('windows')).toBe(false);
    expect(dock.sideOf('windows')).toBe('bottom');
  });

  it('reset restores every default', () => {
    const dock = make();
    dock.move('calendar', 'right', 0);
    dock.toggleCollapse('files');
    dock.setDockWidth('left', 500);
    dock.reset();
    expect(dock.leftIds()).toEqual([
      'calendar',
      'files',
      'windows',
    ]);
    expect(dock.collapsed('files')).toBe(false);
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

  describe('hide / show (View menu visibility)', () => {
    it('hide() removes a widget from every dock and marks it hidden', () => {
      const dock = make();
      dock.hide('files');
      expect(dock.isHidden('files')).toBe(true);
      expect(dock.leftIds()).toEqual(['calendar', 'windows']);
      expect(dock.sideOf('files')).toBeNull();
    });

    it('show() puts it back at its default slot, expanded', () => {
      const dock = make();
      dock.hide('files');
      dock.show('files');
      expect(dock.isHidden('files')).toBe(false);
      // back between calendar and windows, per the registry order
      expect(dock.leftIds()).toEqual(['calendar', 'files', 'windows']);
      expect(dock.collapsed('files')).toBe(false);
    });

    it('hides a bottom-dock widget and restores it to its default dock', () => {
      const dock = make();
      dock.move('windows', 'bottom', 0);
      dock.hide('windows');
      expect(dock.bottomIds()).toEqual([]);
      expect(dock.isHidden('windows')).toBe(true);
      dock.show('windows');
      expect(dock.isHidden('windows')).toBe(false);
      expect(dock.sideOf('windows')).toBe('left');
    });

    it('round-trips the hidden set through persistence', () => {
      const first = make();
      first.hide('files');
      first.hide('windows');

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      const second = TestBed.inject(DockService);
      expect(second.isHidden('files')).toBe(true);
      expect(second.isHidden('windows')).toBe(true);
      expect(second.leftIds()).toEqual(['calendar']);
    });

    it('openAndExpand() un-hides a hidden widget', () => {
      const dock = make();
      dock.hide('files');
      dock.openAndExpand('files');
      expect(dock.isHidden('files')).toBe(false);
      expect(dock.collapsed('files')).toBe(false);
      expect(dock.sideOf('files')).toBe('left');
    });

    it('reset() clears the hidden set', () => {
      const dock = make();
      dock.hide('windows');
      dock.reset();
      expect(dock.isHidden('windows')).toBe(false);
      expect(dock.leftIds()).toContain('windows');
    });

    it('dragging a hidden widget back into a dock un-hides it', () => {
      const dock = make();
      dock.hide('windows');
      dock.move('windows', 'right', 0);
      expect(dock.isHidden('windows')).toBe(false);
      expect(dock.rightIds()).toEqual(['windows']);
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

    it('also drops a disabled widget from the hidden set', () => {
      const dock = make();
      dock.hide('files');
      expect(dock.isHidden('files')).toBe(true);
      dock.reconcileEnabled(new Set(['files']));
      expect(dock.isHidden('files')).toBe(false);
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
