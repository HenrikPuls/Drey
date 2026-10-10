import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DiffView } from '../diff-view';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { HistoryService, historyOriginLabel } from './history.service';

const WHEN = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

interface EntryView {
  id: string;
  when: string;
  what: string;
}

/**
 * "File history…" (ADR-0060): the recorded earlier versions of the open
 * note on the left, the selected one against the editor's current text on
 * the right, and Restore. View-only; see `HistoryService`.
 */
@Component({
  selector: 'app-history-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective, DiffView],
  templateUrl: './history-dialog.html',
  styleUrl: './history-dialog.css',
  host: { '(document:keydown.escape)': 'close()' },
})
export class HistoryDialog {
  protected readonly history = inject(HistoryService);

  protected readonly rows = computed<EntryView[]>(() =>
    this.history.entries().map((entry) => ({
      id: entry.id,
      when: WHEN.format(new Date(entry.at)),
      what: historyOriginLabel(entry.origin),
    })),
  );

  protected readonly canRestore = computed<boolean>(() => {
    const content = this.history.selectedContent();
    return content !== null && content !== this.history.current();
  });

  protected close(): void {
    if (this.history.target() !== null) {
      this.history.close();
    }
  }
}
