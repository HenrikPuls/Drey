import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DiffRow, lineDiff } from '../../../shared/text-diff';
import { ConfirmationService } from '../services/confirmation.service';

/** A collapsed run of unchanged lines between edits (localized preview). */
interface DiffGap {
  type: 'gap';
  count: number;
}

type DiffLine = DiffRow | DiffGap;

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
