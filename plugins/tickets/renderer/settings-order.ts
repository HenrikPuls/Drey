/**
 * The sortable pipeline table's rules (req-50), pure so they are specced
 * without a DOM: the first phase (capture target) and the last (terminal)
 * are pinned; every other row moves anywhere between them.
 */

/** Whether row `from` may land at index `to` in a list of `length` rows. */
export function canMove(length: number, from: number, to: number): boolean {
  if (length < 3 || from === to) {
    return false;
  }
  const first = 1;
  const last = length - 2;
  return from >= first && from <= last && to >= first && to <= last;
}

/** `items` with the entry at `from` moved to index `to` (a copy). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return next;
  }
  next.splice(to, 0, moved);
  return next;
}

/**
 * The index a dragged row lands at, from the pointer's y and the rows'
 * vertical midpoints (`mids`, in list order, the dragged row included),
 * clamped into the movable band.
 */
export function dropIndex(mids: readonly number[], y: number, from: number): number {
  let to = mids.filter((mid) => mid < y).length;
  if (to > from) {
    to -= 1;
  }
  return Math.min(Math.max(to, 1), Math.max(mids.length - 2, 1));
}

/** The folder number a phase gets at `index` (0-based): `10`, `20`, … (T-0041). */
export function folderNumber(index: number): string {
  return String((index + 1) * 10).padStart(2, '0');
}
