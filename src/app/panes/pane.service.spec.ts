import { TestBed } from '@angular/core/testing';
import { PaneService } from './pane.service';

describe('PaneService', () => {
  let panes: PaneService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    panes = TestBed.inject(PaneService);
  });

  it('starts as a single pane, focused, with no tabs', () => {
    expect(panes.paneIds()).toEqual(['p1']);
    expect(panes.focusedId()).toBe('p1');
    expect(panes.focusedPane()).toEqual({ id: 'p1', tabs: [], active: null });
  });

  describe('open', () => {
    it('adds a path as a tab in the focused pane and activates it', () => {
      panes.open('a.md');
      panes.open('b.md');
      expect(panes.pane('p1')).toEqual({ id: 'p1', tabs: ['a.md', 'b.md'], active: 'b.md' });
    });

    it('re-opening an already-open path just activates + focuses its pane (one pane per path)', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'a.md')!;
      expect(panes.focusedId()).toBe(p2);

      panes.focus('p1'); // simulate focus moving back to the left pane
      panes.open('a.md'); // already open in p2 -> reveal, not a second copy
      expect(panes.focusedId()).toBe(p2);
      expect(panes.pane('p1')!.tabs).toEqual(['b.md']);
      expect(panes.pane(p2)!.tabs).toEqual(['a.md']);
    });
  });

  describe('activate / focus', () => {
    it('activate() is a no-op for a path not open in that pane', () => {
      panes.open('a.md');
      panes.activate('p1', 'nope.md');
      expect(panes.pane('p1')!.active).toBe('a.md');
    });

    it('activate() focuses the pane it activates in', () => {
      panes.open('a.md');
      const p2 = panes.splitPane('p1', 'row', 'a.md')!;
      panes.focus('p1');
      expect(panes.focusedId()).toBe('p1');
      panes.activate(p2, 'a.md');
      expect(panes.focusedId()).toBe(p2);
    });

    it('focus() ignores an unknown pane id', () => {
      panes.focus('nope');
      expect(panes.focusedId()).toBe('p1');
    });
  });

  describe('reorder', () => {
    it('moves a tab within its pane', () => {
      panes.open('a.md');
      panes.open('b.md');
      panes.open('c.md');
      panes.reorder('p1', 'a.md', 2);
      expect(panes.pane('p1')!.tabs).toEqual(['b.md', 'c.md', 'a.md']);
    });
  });

  describe('splitPane', () => {
    it('moves the given tab into a new sibling pane and focuses it', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'b.md');
      expect(p2).not.toBeNull();
      expect(panes.paneIds()).toEqual(['p1', p2]);
      expect(panes.pane('p1')).toEqual({ id: 'p1', tabs: ['a.md'], active: 'a.md' });
      expect(panes.pane(p2!)).toEqual({ id: p2, tabs: ['b.md'], active: 'b.md' });
      expect(panes.focusedId()).toBe(p2);
      expect(panes.root()).toEqual({
        kind: 'split',
        id: 's1',
        direction: 'row',
        children: [
          { kind: 'leaf', paneId: 'p1' },
          { kind: 'leaf', paneId: p2 },
        ],
        sizes: [1, 1],
      });
    });

    it('splitting again nests a new split under the chosen pane (arbitrary N panes)', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'b.md')!;
      panes.open('c.md'); // lands in p2 -- the split just focused it
      const p3 = panes.splitPane(p2, 'column', 'c.md')!;
      expect(panes.paneIds()).toEqual(['p1', p2, p3]);
      expect(panes.pane(p2)!.tabs).toEqual(['b.md']);
      expect(panes.pane(p3)!.tabs).toEqual(['c.md']);
    });

    it('returns null for an unknown pane', () => {
      expect(panes.splitPane('nope', 'row')).toBeNull();
    });
  });

  describe('closeInPane / closeEverywhere', () => {
    it('closing a tab activates its neighbour within the same pane', () => {
      panes.open('a.md');
      panes.open('b.md');
      panes.open('c.md');
      panes.activate('p1', 'b.md');
      panes.closeInPane('p1', 'b.md');
      expect(panes.pane('p1')).toEqual({ id: 'p1', tabs: ['a.md', 'c.md'], active: 'c.md' });
    });

    it('closing the last tab in the only pane empties it instead of removing it', () => {
      panes.open('a.md');
      panes.closeInPane('p1', 'a.md');
      expect(panes.paneIds()).toEqual(['p1']);
      expect(panes.pane('p1')).toEqual({ id: 'p1', tabs: [], active: null });
    });

    it('closing the last tab in a split pane collapses it and refocuses the survivor', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'b.md')!;
      expect(panes.focusedId()).toBe(p2);

      panes.closeInPane(p2, 'b.md');
      expect(panes.paneIds()).toEqual(['p1']);
      expect(panes.root()).toEqual({ kind: 'leaf', paneId: 'p1' });
      expect(panes.focusedId()).toBe('p1');
    });

    it('closeEverywhere removes a path from whichever pane has it', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'b.md')!;
      panes.closeEverywhere('b.md');
      expect(panes.paneIds()).toEqual(['p1']);
      expect(panes.pane('p1')!.tabs).toEqual(['a.md']);
      expect(panes.pane(p2)).toBeNull();
    });

    it('closeAllInPane / closeOthersInPane only touch their own pane', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'b.md')!;
      panes.open('c.md'); // focused pane is p2 after the split
      panes.closeOthersInPane(p2, 'b.md');
      expect(panes.pane(p2)!.tabs).toEqual(['b.md']);
      expect(panes.pane('p1')!.tabs).toEqual(['a.md']); // untouched

      panes.closeAllInPane('p1');
      expect(panes.paneIds()).toEqual([p2]); // p1 emptied and collapsed away
    });
  });

  describe('moveToPane', () => {
    it('moves a tab to another pane at the given index and focuses the destination', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'b.md')!;
      panes.open('c.md'); // p2: [b.md, c.md], focused
      panes.focus('p1');

      panes.moveToPane('c.md', 'p1', 0);
      expect(panes.pane('p1')!.tabs).toEqual(['c.md', 'a.md']);
      expect(panes.pane(p2)!.tabs).toEqual(['b.md']);
      expect(panes.focusedId()).toBe('p1');
    });

    it('collapses the source pane if the move empties it', () => {
      panes.open('a.md');
      panes.splitPane('p1', 'row', 'a.md'); // p1: [], p2: [a.md], focused p2
      panes.focus('p1');
      panes.open('b.md'); // p1: [b.md]
      panes.moveToPane('a.md', 'p1', 0);
      expect(panes.paneIds()).toEqual(['p1']);
      expect(panes.pane('p1')!.tabs).toEqual(['a.md', 'b.md']);
    });

    it('is a no-op for an unopened path or an unknown destination', () => {
      panes.open('a.md');
      panes.moveToPane('nope.md', 'p1', 0);
      expect(panes.pane('p1')!.tabs).toEqual(['a.md']);
      panes.moveToPane('a.md', 'nope', 0);
      expect(panes.pane('p1')!.tabs).toEqual(['a.md']);
    });

    it('degrades to a same-pane reorder when source and destination match', () => {
      panes.open('a.md');
      panes.open('b.md');
      panes.moveToPane('a.md', 'p1', 1);
      expect(panes.pane('p1')!.tabs).toEqual(['b.md', 'a.md']);
    });
  });

  describe('renamePath', () => {
    it('re-points a tab (and its active-ness) at the new path, wherever it is', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'b.md')!;
      panes.renamePath('b.md', 'renamed.md');
      expect(panes.pane(p2)).toEqual({ id: p2, tabs: ['renamed.md'], active: 'renamed.md' });
      expect(panes.pane('p1')!.tabs).toEqual(['a.md']); // untouched
    });

    it('is a no-op when the path is not open anywhere', () => {
      panes.open('a.md');
      panes.renamePath('nope.md', 'renamed.md');
      expect(panes.pane('p1')!.tabs).toEqual(['a.md']);
    });
  });

  describe('resizeSplit', () => {
    it('updates the sizes on the matching split node only', () => {
      panes.open('a.md');
      const p2 = panes.splitPane('p1', 'row', 'a.md')!;
      panes.open('b.md'); // in p1
      const p3 = panes.splitPane(p2, 'column', undefined)!;
      const rootBefore = panes.root() as Extract<ReturnType<PaneService['root']>, { kind: 'split' }>;
      const innerSplitId = (rootBefore.children[1] as { id: string }).id;

      panes.resizeSplit(innerSplitId, [3, 1]);
      const root = panes.root() as Extract<ReturnType<PaneService['root']>, { kind: 'split' }>;
      expect(root.sizes).toEqual([1, 1]); // outer split untouched
      const inner = root.children[1] as { sizes: readonly number[] };
      expect(inner.sizes).toEqual([3, 1]);
      expect(panes.paneIds()).toContain(p3);
    });
  });

  describe('snapshot / restore (ADR-0043)', () => {
    it('round-trips a split layout through snapshot -> restore', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'b.md')!;
      panes.open('c.md'); // in p2
      panes.focus('p1');
      const snap = panes.snapshot();

      const fresh = TestBed.inject(PaneService); // same singleton; reset via restore
      const restored = fresh.restore(snap, () => true);

      expect(restored).toBe(true);
      expect(panes.pane('p1')).toEqual({ id: 'p1', tabs: ['a.md'], active: 'a.md' });
      expect(panes.pane(p2)?.tabs).toEqual(['b.md', 'c.md']);
      expect(panes.focusedId()).toBe('p1');
    });

    it('drops tabs that fail keepPath and prunes an emptied pane', () => {
      panes.open('keep.md');
      const p2 = panes.splitPane('p1', 'row', 'keep.md')!;
      panes.open('gone.md'); // p1's only tab
      const snap = panes.snapshot();

      const restored = panes.restore(snap, (p) => p !== 'gone.md');

      expect(restored).toBe(true);
      expect(panes.paneIds()).toEqual([p2]);
      expect(panes.pane(p2)?.tabs).toEqual(['keep.md']);
    });

    it('returns false when nothing survives', () => {
      panes.open('gone.md');
      const snap = panes.snapshot();
      expect(panes.restore(snap, () => false)).toBe(false);
    });
  });

  describe('dock regions (ADR-0038)', () => {
    it('starts with no docked panes and center as the only region', () => {
      panes.open('a.md');
      expect(panes.dockPane('left')).toBeNull();
      expect(panes.dockPane('right')).toBeNull();
      expect(panes.dockPane('bottom')).toBeNull();
      expect(panes.regionOf('p1')).toBe('center');
    });

    describe('detachToDock', () => {
      it('seeds the region, removes the centre leaf and focuses the docked pane', () => {
        panes.open('a.md');
        panes.detachToDock('p1', 'right');
        expect(panes.dockPane('right')).toBe('p1');
        expect(panes.regionOf('p1')).toBe('dock-right');
        expect(panes.focusedId()).toBe('p1');
        // the centre keeps a fresh, tabless placeholder pane
        expect(panes.root()).toEqual({ kind: 'leaf', paneId: 'p2' });
        expect(panes.pane('p2')).toEqual({ id: 'p2', tabs: [], active: null });
        expect(panes.pane('p1')!.tabs).toEqual(['a.md']);
      });

      it('removes a non-root leaf from a split centre without touching the placeholder rule', () => {
        panes.open('a.md');
        panes.open('b.md');
        const p2 = panes.splitPane('p1', 'row', 'b.md')!;
        panes.detachToDock(p2, 'left');
        expect(panes.dockPane('left')).toBe(p2);
        expect(panes.root()).toEqual({ kind: 'leaf', paneId: 'p1' });
        expect(panes.pane(p2)!.tabs).toEqual(['b.md']);
      });

      it('reattaches the occupant when the target dock is taken', () => {
        panes.open('a.md');
        panes.open('b.md');
        const p2 = panes.splitPane('p1', 'row', 'b.md')!;
        panes.detachToDock('p1', 'right');
        panes.detachToDock(p2, 'right'); // right is taken by p1
        expect(panes.dockPane('right')).toBe(p2);
        expect(panes.regionOf('p1')).toBe('center');
        expect(panes.focusedId()).toBe(p2);
        // p1 is back in the centre tree beside the placeholder
        expect(leafIdsOf(panes.root())).toContain('p1');
      });

      it('moves a pane band to band without a centre detour', () => {
        panes.open('a.md');
        panes.detachToDock('p1', 'left');
        panes.detachToDock('p1', 'bottom');
        expect(panes.dockPane('left')).toBeNull();
        expect(panes.dockPane('bottom')).toBe('p1');
        expect(panes.regionOf('p1')).toBe('dock-bottom');
      });

      it('is a no-op for an unknown pane or the pane\'s own dock', () => {
        panes.open('a.md');
        panes.detachToDock('nope', 'left');
        panes.detachToDock('p1', 'right');
        panes.detachToDock('p1', 'right'); // already there
        expect(panes.dockPane('right')).toBe('p1');
        expect(panes.dockPane('left')).toBeNull();
      });
    });

    describe('reattachToCenter', () => {
      it('replaces the centre\'s lone tabless placeholder', () => {
        panes.open('a.md');
        panes.detachToDock('p1', 'right');
        panes.reattachToCenter('p1');
        expect(panes.dockPane('right')).toBeNull();
        expect(panes.root()).toEqual({ kind: 'leaf', paneId: 'p1' });
        expect(panes.pane('p1')!.tabs).toEqual(['a.md']);
        expect(panes.focusedId()).toBe('p1');
        expect(panes.pane('p2')).toBeNull(); // the placeholder record is gone
      });

      it('wraps beside a lone populated centre leaf', () => {
        panes.open('a.md');
        panes.detachToDock('p1', 'right');
        // the centre placeholder gets a tab while p1 is docked
        panes.focus('p2');
        panes.open('b.md');
        panes.reattachToCenter('p1');
        const root = panes.root();
        expect(root.kind).toBe('split');
        expect(leafIdsOf(root)).toEqual(['p2', 'p1']);
        expect(panes.focusedId()).toBe('p1');
      });

      it('appends as the last child of a split centre root', () => {
        panes.open('a.md');
        panes.open('b.md');
        panes.splitPane('p1', 'row', 'b.md'); // p1, p2 in the centre
        panes.detachToDock('p2', 'bottom');
        panes.reattachToCenter('p2');
        const root = panes.root();
        expect(root.kind).toBe('split');
        expect(leafIdsOf(root)).toEqual(['p1', 'p2']);
        expect(panes.dockPane('bottom')).toBeNull();
      });

      it('is a no-op for a centre or unknown pane', () => {
        panes.open('a.md');
        panes.reattachToCenter('p1');
        panes.reattachToCenter('nope');
        expect(panes.paneIds()).toEqual(['p1']);
      });
    });

    describe('collapse of a docked pane', () => {
      it('closing the last tab drops the band and refocuses', () => {
        panes.open('a.md');
        panes.detachToDock('p1', 'right');
        panes.closeInPane('p1', 'a.md');
        expect(panes.dockPane('right')).toBeNull();
        expect(panes.pane('p1')).toBeNull();
        expect(panes.focusedId()).toBe('p2'); // the centre placeholder
      });

      it('dragging the last tab out of a band drops the band', () => {
        panes.open('a.md');
        panes.detachToDock('p1', 'bottom'); // focuses p1, centre placeholder is p2
        panes.focus('p2');
        panes.open('b.md'); // p2: [b.md]
        panes.moveToPane('a.md', 'p2', 0); // p1 empties -> its band goes too
        expect(panes.dockPane('bottom')).toBeNull();
        expect(panes.pane('p1')).toBeNull();
        expect(panes.pane('p2')!.tabs).toEqual(['a.md', 'b.md']);
      });
    });

    it('splitPane refuses a docked pane but still splits centre panes', () => {
      panes.open('a.md');
      panes.open('b.md');
      panes.detachToDock('p1', 'left');
      expect(panes.splitPane('p1', 'row', 'a.md')).toBeNull();
      expect(panes.splitPane('p2', 'row', 'b.md')).not.toBeNull();
    });

    it('open() lands a new tab in a focused docked pane', () => {
      panes.open('a.md');
      panes.detachToDock('p1', 'right');
      panes.open('b.md');
      expect(panes.pane('p1')!.tabs).toEqual(['a.md', 'b.md']);
      expect(panes.pane('p2')!.tabs).toEqual([]);
    });

    it('paneIds lists centre panes first, then the dock bands left -> right -> bottom', () => {
      panes.open('a.md');
      panes.open('b.md');
      panes.splitPane('p1', 'row', 'b.md'); // p1, p2 centre
      panes.detachToDock('p2', 'bottom'); // centre collapses to leaf p1
      panes.detachToDock('p1', 'right'); // centre placeholder p3 minted
      panes.open('c.md'); // lands in the focused docked p1 -- paneIds is about placement
      expect(panes.paneIds()).toEqual(['p3', 'p1', 'p2']);
    });

    it('setBandHeight clamps to the dock band bounds', () => {
      panes.setBandHeight('left', 10);
      expect(panes.bandHeight('left')).toBe(140);
      panes.setBandHeight('left', 99_999);
      expect(panes.bandHeight('left')).toBe(680);
      panes.setBandHeight('left', 300);
      expect(panes.bandHeight('left')).toBe(300);
    });

    it('resetRegions reattaches every docked pane and resets the heights', () => {
      panes.open('a.md');
      panes.open('b.md');
      const p2 = panes.splitPane('p1', 'row', 'b.md')!;
      panes.detachToDock('p1', 'left');
      panes.detachToDock(p2, 'bottom');
      panes.setBandHeight('left', 400);

      panes.resetRegions();

      expect(panes.dockPane('left')).toBeNull();
      expect(panes.dockPane('bottom')).toBeNull();
      expect(panes.bandHeight('left')).toBe(280);
      expect(leafIdsOf(panes.root())).toEqual(['p1', 'p2']);
      expect(panes.focusedId()).toBe('p1'); // deterministic: the first centre pane
    });
  });
});

/** `leafIds` for the test assertions, without exporting the helper through the barrel. */
function leafIdsOf(node: ReturnType<PaneService['root']>): string[] {
  return node.kind === 'leaf' ? [node.paneId] : node.children.flatMap(leafIdsOf);
}
