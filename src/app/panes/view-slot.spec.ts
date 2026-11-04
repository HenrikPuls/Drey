import {
  emptySlot,
  slotAddTab,
  slotHolds,
  slotPaneIds,
  slotRemapIds,
  slotRemoveTab,
  slotRenameTab,
  slotTabs,
} from './view-slot';
import type { ViewSlot } from './view-slot';

function twoPaneSlot(): ViewSlot {
  return {
    root: {
      kind: 'split',
      id: 's1',
      direction: 'row',
      children: [
        { kind: 'leaf', paneId: 'p1' },
        { kind: 'leaf', paneId: 'p2' },
      ],
      sizes: [1, 1],
    },
    panes: {
      p1: { id: 'p1', tabs: ['a', 'b'], active: 'b' },
      p2: { id: 'p2', tabs: ['c'], active: 'c' },
      p3: { id: 'p3', tabs: ['d'], active: 'd' },
    },
    focusedId: 'p2',
    dockPanes: { left: null, right: 'p3', bottom: null },
    bandHeights: { left: 280, right: 280, bottom: 280 },
  };
}

describe('view slots', () => {
  it('lists panes and tabs, docked bands included', () => {
    const slot = twoPaneSlot();
    expect(slotPaneIds(slot)).toEqual(['p1', 'p2', 'p3']);
    expect(slotTabs(slot)).toEqual(['a', 'b', 'c', 'd']);
    expect(slotHolds(slot, 'd')).toBe(true);
    expect(slotHolds(slot, 'x')).toBe(false);
  });

  it('adds a tab to the focused pane, once', () => {
    const slot = slotAddTab(twoPaneSlot(), 'x');
    expect(slot.panes['p2']).toEqual({ id: 'p2', tabs: ['c', 'x'], active: 'x' });
    expect(slotAddTab(slot, 'x')).toBe(slot);
  });

  it('removes a tab and activates a neighbour', () => {
    const slot = slotRemoveTab(twoPaneSlot(), 'b');
    expect(slot.panes['p1']).toEqual({ id: 'p1', tabs: ['a'], active: 'a' });
  });

  it('collapses a centre pane that loses its last tab', () => {
    const slot = slotRemoveTab(twoPaneSlot(), 'c');
    expect(slot.panes['p2']).toBeUndefined();
    expect(slot.root).toEqual({ kind: 'leaf', paneId: 'p1' });
    expect(slot.focusedId).toBe('p1');
  });

  it('takes a docked band away with its last tab', () => {
    const slot = slotRemoveTab(twoPaneSlot(), 'd');
    expect(slot.dockPanes.right).toBeNull();
    expect(slot.panes['p3']).toBeUndefined();
  });

  it('keeps the last centre pane, empty', () => {
    const slot = slotRemoveTab(slotAddTab(emptySlot('p9', 280), 'z'), 'z');
    expect(slot.panes['p9']).toEqual({ id: 'p9', tabs: [], active: null });
  });

  it('renames a tab everywhere in the slot', () => {
    const slot = slotRenameTab(twoPaneSlot(), 'a', 'a2');
    expect(slot.panes['p1']).toEqual({ id: 'p1', tabs: ['a2', 'b'], active: 'b' });
  });

  it('remaps pane and split ids without touching the tabs', () => {
    let pane = 10;
    let split = 10;
    const copy = slotRemapIds(
      twoPaneSlot(),
      () => `p${pane++}`,
      () => `s${split++}`,
    );
    expect(slotPaneIds(copy)).toEqual(['p10', 'p11', 'p12']);
    expect(copy.root).toMatchObject({ kind: 'split', id: 's10' });
    expect(slotTabs(copy)).toEqual(['a', 'b', 'c', 'd']);
    expect(copy.focusedId).toBe('p11');
    expect(copy.dockPanes.right).toBe('p12');
  });
});
