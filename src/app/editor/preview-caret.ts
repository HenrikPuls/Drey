import { blockIndexOfClassName } from './source-map';

/**
 * DOM-side helpers for the auto-switch caret (ADR-0004). Kept out of the
 * component so they can be unit-tested against hand-built fragments; they
 * touch only the passed-in nodes, no component state.
 *
 * "Text offset" throughout means a character count over the concatenated
 * text nodes under a root element -- the same coordinate
 * `alignRenderedToSource` works in.
 */

/**
 * Character offset, within `root`'s text content, of the DOM point
 * `(node, offset)`. Handles element points (where `offset` is a child
 * index) by delegating to `Range`, which counts text natively.
 */
export function domPointToTextOffset(root: HTMLElement, node: Node, offset: number): number {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch {
    // Point is outside `root` (e.g. a click in the scroll padding): clamp.
    return root.textContent?.length ?? 0;
  }
  return range.toString().length;
}

/** Inverse of `domPointToTextOffset`: the text node / offset at `target`. */
export function textOffsetToDomPoint(
  root: HTMLElement,
  target: number,
): { node: Node; offset: number } {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (seen + n.data.length >= target) {
      return { node: n, offset: Math.max(0, target - seen) };
    }
    seen += n.data.length;
    last = n;
  }
  if (last) {
    return { node: last, offset: last.data.length };
  }
  return { node: root, offset: 0 };
}

/**
 * The `cm-src-<n>` index of the nearest tagged block ancestor of `node`
 * (inclusive), or `null` when the point is not inside a mapped block.
 * Walks parents by hand rather than via `closest()` -- the marker is one
 * class among several (`language-*`, markdown-it's own), not a selector.
 */
export function blockIndexForNode(node: Node | null, root: HTMLElement): number | null {
  let el: Element | null =
    node == null
      ? null
      : node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
  while (el && root.contains(el)) {
    const index = blockIndexOfClassName(el.className);
    if (index !== null) {
      return index;
    }
    el = el.parentElement;
  }
  return null;
}
