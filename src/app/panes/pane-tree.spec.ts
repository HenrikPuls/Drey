import { appendChild, leafIds, moveWithinArray, PaneNode, removeLeaf, replaceLeaf } from './pane-tree';

const leaf = (paneId: string): PaneNode => ({ kind: 'leaf', paneId });

describe('pane-tree', () => {
  describe('leafIds', () => {
    it('returns the single leaf for a one-pane tree', () => {
      expect(leafIds(leaf('p1'))).toEqual(['p1']);
    });

    it('walks nested splits in document order', () => {
      const tree: PaneNode = {
        kind: 'split',
        id: 's1',
        direction: 'row',
        sizes: [1, 1],
        children: [
          leaf('p1'),
          { kind: 'split', id: 's2', direction: 'column', sizes: [1, 1], children: [leaf('p2'), leaf('p3')] },
        ],
      };
      expect(leafIds(tree)).toEqual(['p1', 'p2', 'p3']);
    });
  });

  describe('replaceLeaf', () => {
    it('replaces the matching leaf with a split, leaving the rest untouched', () => {
      const tree: PaneNode = {
        kind: 'split',
        id: 's1',
        direction: 'row',
        sizes: [1, 1],
        children: [leaf('p1'), leaf('p2')],
      };
      const replacement: PaneNode = {
        kind: 'split',
        id: 's2',
        direction: 'column',
        sizes: [1, 1],
        children: [leaf('p1'), leaf('p3')],
      };
      const next = replaceLeaf(tree, 'p1', replacement);
      expect(leafIds(next)).toEqual(['p1', 'p3', 'p2']);
    });

    it('is a no-op when the id is not found', () => {
      const tree = leaf('p1');
      expect(replaceLeaf(tree, 'nope', leaf('p2'))).toBe(tree);
    });
  });

  describe('removeLeaf', () => {
    it('refuses to remove the only leaf in the tree', () => {
      const tree = leaf('p1');
      expect(removeLeaf(tree, 'p1')).toBe(tree);
    });

    it('collapses a two-pane split down to the surviving leaf', () => {
      const tree: PaneNode = {
        kind: 'split',
        id: 's1',
        direction: 'row',
        sizes: [1, 2],
        children: [leaf('p1'), leaf('p2')],
      };
      expect(removeLeaf(tree, 'p1')).toEqual(leaf('p2'));
    });

    it('drops one child of a three-way split and keeps the sizes aligned', () => {
      const tree: PaneNode = {
        kind: 'split',
        id: 's1',
        direction: 'row',
        sizes: [1, 2, 3],
        children: [leaf('p1'), leaf('p2'), leaf('p3')],
      };
      const next = removeLeaf(tree, 'p2') as Extract<PaneNode, { kind: 'split' }>;
      expect(next.children).toEqual([leaf('p1'), leaf('p3')]);
      expect(next.sizes).toEqual([1, 3]);
    });

    it('removes a leaf nested inside a sub-split and collapses just that sub-split', () => {
      const tree: PaneNode = {
        kind: 'split',
        id: 's1',
        direction: 'row',
        sizes: [1, 1],
        children: [
          leaf('p1'),
          { kind: 'split', id: 's2', direction: 'column', sizes: [1, 1], children: [leaf('p2'), leaf('p3')] },
        ],
      };
      const next = removeLeaf(tree, 'p2') as Extract<PaneNode, { kind: 'split' }>;
      expect(next.children).toEqual([leaf('p1'), leaf('p3')]);
    });

    it('is a no-op when the id is not found', () => {
      const tree: PaneNode = {
        kind: 'split',
        id: 's1',
        direction: 'row',
        sizes: [1, 1],
        children: [leaf('p1'), leaf('p2')],
      };
      expect(removeLeaf(tree, 'nope')).toEqual(tree);
    });
  });

  describe('appendChild', () => {
    it('wraps a lone leaf in a fresh row split with the child beside it', () => {
      const next = appendChild(leaf('p1'), leaf('p2'), 's9');
      expect(next).toEqual({
        kind: 'split',
        id: 's9',
        direction: 'row',
        sizes: [1, 1],
        children: [leaf('p1'), leaf('p2')],
      });
    });

    it('appends to a split root, keeping its direction and growing the sizes', () => {
      const tree: PaneNode = {
        kind: 'split',
        id: 's1',
        direction: 'column',
        sizes: [2, 1],
        children: [leaf('p1'), leaf('p2')],
      };
      const next = appendChild(tree, leaf('p3'), 's9') as Extract<PaneNode, { kind: 'split' }>;
      expect(next.id).toBe('s1');
      expect(next.direction).toBe('column');
      expect(next.children).toEqual([leaf('p1'), leaf('p2'), leaf('p3')]);
      expect(next.sizes).toEqual([2, 1, 1]);
    });
  });

  describe('moveWithinArray', () => {
    it('moves an item to a later index', () => {
      expect(moveWithinArray(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    });

    it('moves an item to an earlier index', () => {
      expect(moveWithinArray(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    });

    it('clamps an out-of-range index', () => {
      expect(moveWithinArray(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
    });

    it('returns an equivalent (but new) array when the item is already at that index', () => {
      const list = ['a', 'b', 'c'];
      const next = moveWithinArray(list, 'b', 1);
      expect(next).toEqual(list);
      expect(next).not.toBe(list);
    });

    it('returns an equivalent array when the item is absent', () => {
      expect(moveWithinArray(['a', 'b'], 'z', 0)).toEqual(['a', 'b']);
    });
  });
});
