import { TestBed } from '@angular/core/testing';
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
    expect(dock.bottomIds()).toEqual(['calendar', 'entry']);
    expect(dock.leftIds()).toEqual(['files', 'search', 'tasks', 'windows']);
    dock.setBottomHeight(10);
    expect(dock.dockHeight()).toBe(140);
    dock.setBottomHeight(9000);
    expect(dock.dockHeight()).toBe(680);
  });

  it('re-places the entry panel into the bottom dock when a stored blob predates it', () => {
    localStorage.setItem(
      'drey.dock',
      JSON.stringify({
        dock: { left: ['calendar', 'files', 'search', 'windows'], right: ['assistant'] },
      }),
    );
    const dock = make();
    expect(dock.bottomIds()).toEqual(['entry']);
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
    // left: [calendar, files, search(collapsed), tasks(collapsed), windows]
    expect(dock.nextOpenId('calendar')).toBe('files');
    expect(dock.nextOpenId('files')).toBe('windows'); // search + tasks are collapsed
    expect(dock.nextOpenId('windows')).toBeNull();
    expect(dock.nextOpenId('assistant')).toBeNull(); // alone in the right dock
  });

  it('moves a panel across docks at the requested slot', () => {
    const dock = make();
    dock.move('calendar', 'right', 0);
    expect(dock.leftIds()).toEqual(['files', 'search', 'tasks', 'windows']);
    expect(dock.rightIds()).toEqual(['calendar', 'assistant']);
  });

  it('reorders within a dock (drop-line index is pre-removal)', () => {
    const dock = make();
    // Move `calendar` to sit after `files`: visual slot 2 in the original list.
    dock.move('calendar', 'left', 2);
    expect(dock.leftIds()).toEqual([
      'files',
      'calendar',
      'search',
      'tasks',
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
    expect(dock.collapsed('search')).toBe(true);
    dock.openAndExpand('search');
    expect(dock.collapsed('search')).toBe(false);
    expect(dock.sideOf('search')).toBe('left');
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
      'search',
      'tasks',
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
    expect(second.rightIds()).toEqual(['calendar', 'assistant']);
    expect(second.dockWidth('right')).toBe(400);
  });

  it('ignores a corrupt stored blob', () => {
    localStorage.setItem('drey.dock', '{ not json');
    const dock = make();
    expect(dock.leftIds()).toEqual([
      'calendar',
      'files',
      'search',
      'tasks',
      'windows',
    ]);
  });

  it('re-places a panel missing from a stored blob', () => {
    localStorage.setItem(
      'drey.dock',
      JSON.stringify({ dock: { left: ['calendar', 'files'], right: [] } }),
    );
    const dock = make();
    // search + tasks + windows (left by default) and assistant (right) come back.
    expect(dock.leftIds()).toEqual([
      'calendar',
      'files',
      'search',
      'tasks',
      'windows',
    ]);
    expect(dock.rightIds()).toEqual(['assistant']);
  });

  describe('hide / show (View menu visibility)', () => {
    it('hide() removes a widget from every dock and marks it hidden', () => {
      const dock = make();
      dock.hide('search');
      expect(dock.isHidden('search')).toBe(true);
      expect(dock.leftIds()).toEqual(['calendar', 'files', 'tasks', 'windows']);
      expect(dock.sideOf('search')).toBeNull();
    });

    it('show() puts it back at its default slot, expanded', () => {
      const dock = make();
      dock.hide('search');
      dock.show('search');
      expect(dock.isHidden('search')).toBe(false);
      // back between files and tasks, per the registry order
      expect(dock.leftIds()).toEqual(['calendar', 'files', 'search', 'tasks', 'windows']);
      expect(dock.collapsed('search')).toBe(false);
    });

    it('hides the bottom-dock entry widget and restores it', () => {
      const dock = make();
      dock.hide('entry');
      expect(dock.bottomIds()).toEqual([]);
      expect(dock.isHidden('entry')).toBe(true);
      dock.show('entry');
      expect(dock.bottomIds()).toEqual(['entry']);
    });

    it('round-trips the hidden set through persistence', () => {
      const first = make();
      first.hide('search');
      first.hide('tasks');

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});
      const second = TestBed.inject(DockService);
      expect(second.isHidden('search')).toBe(true);
      expect(second.isHidden('tasks')).toBe(true);
      expect(second.leftIds()).toEqual(['calendar', 'files', 'windows']);
    });

    it('openAndExpand() un-hides a hidden widget', () => {
      const dock = make();
      dock.hide('search');
      dock.openAndExpand('search');
      expect(dock.isHidden('search')).toBe(false);
      expect(dock.collapsed('search')).toBe(false);
      expect(dock.sideOf('search')).toBe('left');
    });

    it('reset() clears the hidden set', () => {
      const dock = make();
      dock.hide('tasks');
      dock.reset();
      expect(dock.isHidden('tasks')).toBe(false);
      expect(dock.leftIds()).toContain('tasks');
    });

    it('dragging a hidden widget back into a dock un-hides it', () => {
      const dock = make();
      dock.hide('tasks');
      dock.move('tasks', 'right', 0);
      expect(dock.isHidden('tasks')).toBe(false);
      expect(dock.rightIds()).toEqual(['tasks', 'assistant']);
    });
  });

  describe('reconcileEnabled (Settings -> Widgets)', () => {
    it('drops a disabled widget from its dock', () => {
      const dock = make();
      dock.reconcileEnabled(new Set(['tasks', 'search']));
      expect(dock.leftIds()).toEqual(['calendar', 'files', 'windows']);
      expect(dock.sideOf('tasks')).toBeNull();
      expect(dock.sideOf('search')).toBeNull();
    });

    it('also drops a disabled widget from the hidden set', () => {
      const dock = make();
      dock.hide('tasks');
      expect(dock.isHidden('tasks')).toBe(true);
      dock.reconcileEnabled(new Set(['tasks']));
      expect(dock.isHidden('tasks')).toBe(false);
      expect(dock.sideOf('tasks')).toBeNull();
    });

    it('re-homes a widget that is enabled again and now nowhere', () => {
      const dock = make();
      dock.reconcileEnabled(new Set(['tasks']));
      expect(dock.leftIds()).not.toContain('tasks');
      dock.reconcileEnabled(new Set());
      expect(dock.leftIds()).toEqual(['calendar', 'files', 'search', 'tasks', 'windows']);
    });
    it('is a no-op when nothing is disabled', () => {
      const dock = make();
      const before = JSON.stringify(localStorage.getItem('drey.dock'));
      dock.reconcileEnabled(new Set());
      expect(JSON.stringify(localStorage.getItem('drey.dock'))).toBe(before);
    });
  });
});
