/**
 * The card menu's move-to-end targets (T-0053): the `reorder` drop index
 * that puts a card first / last in its column, or null when it already
 * sits at that end (the item is disabled then). Pure so the index math
 * is specced without a DOM — a menu move reuses the drag's `reorder`
 * IPC unchanged.
 */

export interface CardOrderTargets {
  /** Reorder drop index that puts the card first; null when it is already first. */
  readonly top: number | null;
  /** Reorder drop index that puts the card last; null when it is already last. */
  readonly bottom: number | null;
}

export function cardOrderTargets(
  tickets: readonly { readonly id: string }[],
  id: string,
): CardOrderTargets {
  const index = tickets.findIndex((t) => t.id === id);
  if (index < 0) {
    // A stale menu (the card left the column since the snapshot).
    return { top: null, bottom: null };
  }
  const last = tickets.length - 1;
  return {
    top: index === 0 ? null : 0,
    bottom: index === last ? null : last,
  };
}
