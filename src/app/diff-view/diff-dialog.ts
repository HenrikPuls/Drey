import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { DiffDialogService } from './diff-dialog.service';
import { DiffView } from './diff-view';

/**
 * A read-only before / after comparison (SDK 1.17): what `api.ui.showDiff`
 * opens -- the git plugin's "what changed in this file". View-only; see
 * `DiffDialogService`.
 */
@Component({
  selector: 'app-diff-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective, DiffView],
  templateUrl: './diff-dialog.html',
  styleUrl: './diff-dialog.css',
  host: { '(document:keydown.escape)': 'close()' },
})
export class DiffDialog {
  protected readonly diff = inject(DiffDialogService);

  protected close(): void {
    if (this.diff.request() !== null) {
      this.diff.close();
    }
  }
}
