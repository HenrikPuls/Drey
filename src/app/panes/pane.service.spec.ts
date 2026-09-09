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
});
