import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DiffRow, lineDiff } from '../../../shared/text-diff';

/** A collapsed run of unchanged lines between edits. */
interface DiffGap {
  type: 'gap';
  count: number;
}

type DiffLine = DiffRow | DiffGap;

/** One side of a split-diff row; `empty` is a placeholder so both columns stay row-aligned. */
interface SplitCell {
  type: 'context' | 'add' | 'del' | 'empty';
  text: string;
  lineNo: number | null;
}

/** A row of the side-by-side diff: the two columns are always the same height. */
type SplitRow = { type: 'pair'; left: SplitCell; right: SplitCell } | DiffGap;

const EMPTY_CELL: SplitCell = { type: 'empty', text: '', lineNo: null };

/**
 * Turns the (already context-collapsed) line diff into aligned two-column
 * rows: a `context` line shows on both sides, and a run of `del`/`add`
 * lines is zipped so removed and added lines sit on the same row (GitHub
 * split-diff style). Left-over removals get an empty right cell and vice
 * versa, so every row has exactly one left and one right cell -- the two
 * halves are structurally identical in size.
 */
function buildSplitRows(lines: readonly DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: DiffRow[] = [];
  let adds: DiffRow[] = [];

  const flushChange = (): void => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      out.push({
        type: 'pair',
        left: d ? { type: 'del', text: d.text, lineNo: d.beforeLine } : EMPTY_CELL,
        right: a ? { type: 'add', text: a.text, lineNo: a.afterLine } : EMPTY_CELL,
      });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    if (line.type === 'gap') {
      flushChange();
      out.push(line);
    } else if (line.type === 'del') {
      dels.push(line);
    } else if (line.type === 'add') {
      adds.push(line);
    } else {
      flushChange();
      out.push({
        type: 'pair',
        left: { type: 'context', text: line.text, lineNo: line.beforeLine },
        right: { type: 'context', text: line.text, lineNo: line.afterLine },
      });
    }
  }
  flushChange();
  return out;
}

/** Keep `pad` context lines around each change; collapse longer unchanged runs. */
function collapseContext(rows: readonly DiffRow[], pad = 3): DiffLine[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.type === 'context') {
      return;
    }
    for (let j = Math.max(0, i - pad); j <= Math.min(rows.length - 1, i + pad); j++) {
      keep[j] = true;
    }
  });

  const out: DiffLine[] = [];
  let run = 0;
  rows.forEach((row, i) => {
    if (keep[i]) {
      if (run > 0) {
        out.push({ type: 'gap', count: run });
        run = 0;
      }
      out.push(row);
    } else {
      run++;
    }
  });
  if (run > 0) {
    out.push({ type: 'gap', count: run });
  }
  return out;
}

/**
 * The line diff every dialog shows (ADR-0011's confirmation, the save
 * conflict and the note history, ADR-0060): `inline` is a +/- line list,
 * `split` an aligned before / after pair of equal-size columns. Long
 * unchanged runs collapse in both. Presentation only -- the host supplies
 * the scroll container.
 */
@Component({
  selector: 'app-diff-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './diff-view.html',
  styleUrl: './diff-view.css',
})
export class DiffView {
  readonly before = input.required<string>();
  readonly after = input.required<string>();
  readonly mode = input<'inline' | 'split'>('split');
  readonly beforeLabel = input('Before');
  readonly afterLabel = input('After');

  protected readonly inlineRows = computed<DiffLine[]>(() =>
    this.mode() === 'inline' ? collapseContext(lineDiff(this.before(), this.after())) : [],
  );

  /** More context padding than the inline list: a split view reads as a document. */
  protected readonly splitRows = computed<SplitRow[]>(() =>
    this.mode() === 'split' ? buildSplitRows(collapseContext(lineDiff(this.before(), this.after()), 4)) : [],
  );

  protected readonly unchanged = computed<boolean>(() => this.before() === this.after());
}
