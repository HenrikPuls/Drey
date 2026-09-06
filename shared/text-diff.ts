/**
 * Line-level diffing for the confirmation dialog (ADR-0011) and the
 * preview-style heuristic. Pure and dependency-free; lives in `shared/` so
 * the renderer component and the Vitest suite both use it and the fragile
 * LCS is covered.
 *
 * `lineDiff` is a classic longest-common-subsequence walk over lines --
 * fine for the sizes involved here (a note, a master document), and it
 * keeps unchanged lines aligned so the "inline diff of just the affected
 * lines" view can collapse long runs of context.
 */

export type DiffRowType = 'context' | 'add' | 'del';

export interface DiffRow {
  type: DiffRowType;
  text: string;
  /** 1-based line number on the "before" side (`null` for an added line). */
  beforeLine: number | null;
  /** 1-based line number on the "after" side (`null` for a removed line). */
  afterLine: number | null;
}

function splitLines(text: string): string[] {
  // A trailing newline should not produce a phantom empty final line in the
  // diff -- `"a\n"` is one line, same as `"a"` for display purposes.
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function lineDiff(before: string, after: string): DiffRow[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the LCS of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: 'context', text: a[i], beforeLine: i + 1, afterLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: 'del', text: a[i], beforeLine: i + 1, afterLine: null });
      i++;
    } else {
      rows.push({ type: 'add', text: b[j], beforeLine: null, afterLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: 'del', text: a[i], beforeLine: i + 1, afterLine: null });
    i++;
  }
  while (j < m) {
    rows.push({ type: 'add', text: b[j], beforeLine: null, afterLine: j + 1 });
    j++;
  }
  return rows;
}

/** `{ added, removed }` line counts for a before/after pair. */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of lineDiff(before, after)) {
    if (row.type === 'add') {
      added++;
    } else if (row.type === 'del') {
      removed++;
    }
  }
  return { added, removed };
}

/**
 * Chooses the confirmation preview for a change whose template did not
 * pin one (an ad-hoc Ask-mode edit): a small, localized touch gets the
 * inline line diff; anything that rewrites a large fraction of the
 * document gets side-by-side, where a line diff would be unreadable.
 *
 * Heuristic: `'document'` when more than ~35% of the original lines are
 * touched, or when the document is rewritten to a very different length.
 */
export function pickPreviewStyle(before: string, after: string): 'localized' | 'document' {
  if (before.trim() === '') {
    return 'document';
  }
  const beforeLines = splitLines(before).length;
  const { added, removed } = diffStats(before, after);
  const touched = added + removed;
  if (removed > beforeLines * 0.35 || touched > beforeLines) {
    return 'document';
  }
  return 'localized';
}
