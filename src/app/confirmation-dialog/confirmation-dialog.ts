import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { DiffView } from '../diff-view';
import { ConfirmationService } from '../llm';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';

/**
 * The one confirmation dialog shared by the Actions system and chat
 * Ask-mode edits (ADR-0011). Two previews, chosen by
 * `request.previewStyle`: `'localized'` shows an inline line-level diff
 * (long unchanged runs collapsed); `'document'` shows before / after side
 * by side. The "don't ask again for this action" checkbox flips the
 * originating trigger's `confirm` toggle -- same state as Settings.
 *
 * View-only: the state and the "don't ask again" wiring live in
 * `ConfirmationService` / `SettingsService`; the diff itself is the shared
 * `DiffView`.
 */
@Component({
  selector: 'app-confirmation-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective, DiffView],
  templateUrl: './confirmation-dialog.html',
  styleUrl: './confirmation-dialog.css',
  host: { '(document:keydown.escape)': 'onCancel()' },
})
export class ConfirmationDialog {
  protected readonly confirmation = inject(ConfirmationService);
  protected readonly pending = this.confirmation.pending;

  protected readonly dontAskAgain = signal(false);

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
