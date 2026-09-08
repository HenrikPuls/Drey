import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DiffRow, lineDiff } from '../../../shared/text-diff';
import { ConfirmationService } from '../services/confirmation.service';

/** A collapsed run of unchanged lines between edits (localized preview). */
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
 * The one confirmation dialog shared by the Actions system and chat
 * Ask-mode edits (ADR-0011). Two previews, chosen by
 * `request.previewStyle`: `'localized'` shows an inline line-level diff
 * (long unchanged runs collapsed); `'document'` shows before / after side
 * by side. The "don't ask again for this action" checkbox flips the
 * originating trigger's `confirm` toggle -- same state as Settings.
 *
 * View-only: the state and the "don't ask again" wiring live in
 * `ConfirmationService` / `SettingsService`.
 */
@Component({
  selector: 'app-confirmation-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './confirmation-dialog.html',
  styleUrl: './confirmation-dialog.css',
  host: { '(document:keydown.escape)': 'onCancel()' },
})
export class ConfirmationDialog {
  protected readonly confirmation = inject(ConfirmationService);
  protected readonly pending = this.confirmation.pending;

  protected readonly dontAskAgain = signal(false);

  protected readonly diffLines = computed<DiffLine[]>(() => {
    const req = this.pending();
    if (!req || req.previewStyle !== 'localized') {
      return [];
    }
    return collapseContext(lineDiff(req.before, req.after));
  });

  /**
   * The `'document'` preview: a side-by-side diff (not two raw dumps) whose
   * two columns are always the exact same size. Context runs are collapsed
   * like the localized view -- a whole-document rewrite would otherwise be
   * unscrollably long -- but with more padding kept.
   */
  protected readonly splitDiffRows = computed<SplitRow[]>(() => {
    const req = this.pending();
    if (!req || req.previewStyle !== 'document') {
      return [];
    }
    return buildSplitRows(collapseContext(lineDiff(req.before, req.after), 4));
  });

  protected onConfirm(): void {
    this.confirmation.confirm(this.dontAskAgain());
    this.dontAskAgain.set(false);
  }

  protected onCancel(): void {
    if (this.pending()) {
      this.confirmation.cancel();
      this.dontAskAgain.set(false);
    }
  }
}
