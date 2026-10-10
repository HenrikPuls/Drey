import { lineDiff } from '../../../shared/text-diff';

/** A run of lines both versions share. */
export interface ContextSegment {
  kind: 'context';
  lines: string[];
  /** The result pane's text once the user typed in it; `null` = untouched. */
  edited: string | null;
}

/** A block where the two versions differ. */
export interface HunkSegment {
  kind: 'hunk';
  disk: string[];
  mine: string[];
  /** Which sides go into the result -- both means disk's lines, then mine. */
  takeDisk: boolean;
  takeMine: boolean;
  /**
   * Both sides changed this block since the tab last read the file, so
   * neither is the obvious pick (the preselection then keeps mine).
   */
  conflict: boolean;
  edited: string | null;
}

export type MergeSegment = ContextSegment | HunkSegment;

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Whether the non-empty `block` occurs in `lines` as one contiguous run. */
function containsRun(lines: readonly string[], block: readonly string[]): boolean {
  for (let i = 0; i + block.length <= lines.length; i++) {
    let k = 0;
    while (k < block.length && lines[i + k] === block[k]) {
      k++;
    }
    if (k === block.length) {
      return true;
    }
  }
  return false;
}

/**
 * Splits two versions of a note into the blocks they share and the blocks
 * where they differ (ADR-0060, the merge view). `base` -- what the tab
 * last read from disk -- only steers the PRESELECTION: a block that one
 * side left as it was in `base` was changed by the other side alone, so
 * that other side is taken; a block both changed is flagged a conflict
 * and starts on "mine". It is a hint, not a three-way merge: the user sees
 * and can flip every block.
 */
export function buildMerge(base: string, disk: string, mine: string): MergeSegment[] {
  const baseLines = splitLines(base);
  const segments: MergeSegment[] = [];
  let context: string[] = [];
  let diskRun: string[] = [];
  let mineRun: string[] = [];

  const flushContext = (): void => {
    if (context.length > 0) {
      segments.push({ kind: 'context', lines: context, edited: null });
      context = [];
    }
  };
  const flushHunk = (): void => {
    if (diskRun.length === 0 && mineRun.length === 0) {
      return;
    }
    // A side without lines is "as in base" exactly when the other side's
    // lines are new: then the other side inserted them. Otherwise this
    // side deleted lines that base had.
    const diskIsBase = diskRun.length > 0 ? containsRun(baseLines, diskRun) : !containsRun(baseLines, mineRun);
    const mineIsBase = mineRun.length > 0 ? containsRun(baseLines, mineRun) : !diskIsBase;
    const onlyDiskChanged = mineIsBase && !diskIsBase;
    segments.push({
      kind: 'hunk',
      disk: diskRun,
      mine: mineRun,
      takeDisk: onlyDiskChanged,
      takeMine: !onlyDiskChanged,
      conflict: diskIsBase === mineIsBase,
      edited: null,
    });
    diskRun = [];
    mineRun = [];
  };

  for (const row of lineDiff(disk, mine)) {
    if (row.type === 'context') {
      flushHunk();
      context.push(row.text);
    } else {
      flushContext();
      (row.type === 'del' ? diskRun : mineRun).push(row.text);
    }
  }
  flushHunk();
  flushContext();
  return segments;
}

/** The lines a block contributes as selected, before any typing. */
export function selectedLines(segment: MergeSegment): string[] {
  if (segment.kind === 'context') {
    return segment.lines;
  }
  return [...(segment.takeDisk ? segment.disk : []), ...(segment.takeMine ? segment.mine : [])];
}

/** What the result pane shows for a block. */
export function segmentText(segment: MergeSegment): string {
  return segment.edited ?? selectedLines(segment).join('\n');
}

function resultLines(segment: MergeSegment): string[] {
  if (segment.edited === null) {
    return selectedLines(segment);
  }
  // A cleared field removes the block; anything else is taken line by line.
  return segment.edited === '' ? [] : segment.edited.split('\n');
}

/**
 * The merged note. Picking one side for every block, untouched, gives that
 * side back byte for byte; anything else is the blocks joined, ending in a
 * newline when `mine` did.
 */
export function mergeResult(segments: readonly MergeSegment[], disk: string, mine: string): string {
  const untouched = segments.every((s) => s.edited === null);
  const hunks = segments.filter((s): s is HunkSegment => s.kind === 'hunk');
  if (untouched && hunks.every((h) => h.takeMine && !h.takeDisk)) {
    return mine;
  }
  if (untouched && hunks.every((h) => h.takeDisk && !h.takeMine)) {
    return disk;
  }
  const text = segments.flatMap(resultLines).join('\n');
  return mine.endsWith('\n') && text !== '' ? `${text}\n` : text;
}
