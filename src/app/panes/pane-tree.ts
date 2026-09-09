/**
 * Pure tree helpers for the editor pane layout (`PaneService`). A `PaneNode`
 * is either a `leaf` (one pane, identified by id) or a `split` (a row/column
 * of child nodes with `flex-grow` `sizes`, same weight-array idea as
 * `DockService.flexes`). Kept pure and split out from the service for the
 * same reason `tagPillDecorations` / `concealDecorations` are: easy to unit
 * test without Angular or a DOM.
 *
 * Invariant the service relies on: the tree always has at least one leaf --
 * removing the very last one is refused here (returns the tree unchanged);
 * the service turns that into "empty the pane instead of removing it".
 */

export type PaneNode =
  | { readonly kind: 'leaf'; readonly paneId: string }
  | {
      readonly kind: 'split';
      readonly id: string;
      readonly direction: 'row' | 'column';
      readonly children: readonly PaneNode[];
      readonly sizes: readonly number[];
    };

/** Every leaf's pane id, in document order (used to pick a fallback focus target). */
export function leafIds(node: PaneNode): string[] {
  return node.kind === 'leaf' ? [node.paneId] : node.children.flatMap(leafIds);
}

/** Replaces the leaf for `paneId` with `replacement`. No-op (`node` back) if not found. */
export function replaceLeaf(node: PaneNode, paneId: string, replacement: PaneNode): PaneNode {
  if (node.kind === 'leaf') {
    return node.paneId === paneId ? replacement : node;
  }
  return { ...node, children: node.children.map((c) => replaceLeaf(c, paneId, replacement)) };
}

/**
 * Removes the leaf for `paneId`, collapsing a split down to its remaining
 * child when only one is left. Returns `node` unchanged if `paneId` is the
 * tree's only leaf -- the caller (`PaneService`) treats that as "empty the
 * pane in place" instead of removing it.
 */
export function removeLeaf(node: PaneNode, paneId: string): PaneNode {
  if (leafIds(node).length <= 1) {
    return node;
  }
  return removeLeafUnchecked(node, paneId);
}

function removeLeafUnchecked(node: PaneNode, paneId: string): PaneNode {
  if (node.kind === 'leaf') {
    return node; // caller only recurses into splits that might contain it
  }
  const kept: PaneNode[] = [];
  const keptSizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.kind === 'leaf' && child.paneId === paneId) {
      continue; // drop it
    }
    kept.push(child.kind === 'split' ? removeLeafUnchecked(child, paneId) : child);
    keptSizes.push(node.sizes[i]);
  }
  if (kept.length === 1) {
    return kept[0]; // a split with one child left is no split at all
  }
  return { ...node, children: kept, sizes: keptSizes };
}

/** Moves `item` within `list` to `toIndex` (clamped). Same array if already there or `item` is absent. */
export function moveWithinArray<T>(list: readonly T[], item: T, toIndex: number): T[] {
  const from = list.indexOf(item);
  if (from === -1) {
    return list.slice();
  }
  const clamped = Math.max(0, Math.min(list.length - 1, toIndex));
  if (clamped === from) {
    return list.slice();
  }
  const next = list.slice();
  next.splice(from, 1);
  next.splice(clamped, 0, item);
  return next;
}
