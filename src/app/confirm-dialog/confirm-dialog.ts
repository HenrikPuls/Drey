import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { ConfirmDialogService } from '../services/confirm-dialog.service';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';

/**
 * The generic confirm/message dialog (`ConfirmDialogService`'s UI,
 * view-only and always mounted -- `@if (current())` gates the backdrop +
 * dialog, the same pattern as the Exit prompt). It replaced the renderer's
 * native `confirm()`/`alert()`, which break Windows keyboard focus after
 * being dismissed (electron#41602: no caret, typing dead until an
 * Alt+Tab round trip).
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective],
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.css',
  host: { '(document:keydown.escape)': 'service.cancel()' },
})
export class ConfirmDialog {
  protected readonly service = inject(ConfirmDialogService);

  /** The confirm/OK button -- focused when a dialog opens, so Enter accepts. */
  private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');

  constructor() {
    effect(() => {
      if (!this.confirmButton()) {
        return;
      }
      // Once the @if has painted the dialog into the DOM.
      setTimeout(() => this.confirmButton()?.nativeElement.focus());
    });
  }
}
