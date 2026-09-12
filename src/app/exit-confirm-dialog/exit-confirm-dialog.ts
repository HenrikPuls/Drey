import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ExitConfirmService } from '../services/exit-confirm.service';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';

/**
 * The save-before-exit prompt (bug-5): "Save all", "Exit without saving",
 * "Cancel". Shown only when main's close interception found dirty text
 * documents (a clean exit never opens it); state and wiring live in
 * `ExitConfirmService`, this component is view-only and always mounted --
 * `@if (pending())` gates the backdrop + dialog.
 */
@Component({
  selector: 'app-exit-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective],
  templateUrl: './exit-confirm-dialog.html',
  styleUrl: './exit-confirm-dialog.css',
  host: { '(document:keydown.escape)': 'service.cancel()' },
})
export class ExitConfirmDialog {
  protected readonly service = inject(ExitConfirmService);
  protected readonly pending = this.service.pending;
  protected readonly busy = this.service.busy;
  protected readonly dirtyCount = this.service.dirtyCount;
}
