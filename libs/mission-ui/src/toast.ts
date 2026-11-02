import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MC_TOAST_STATE } from './toast.model';

/**
 * The shell's toast pill (the prototype's .toast): one mono pill, bottom
 * centered above the tab bar, auto-hidden after 2.2 s. The message and
 * the timer live on the bound `McToastState` (`toastMessage()` — any
 * surface can raise one), this component only renders the current message
 * and its kind tint.
 */
@Component({
  selector: 'mc-toast',
  templateUrl: './toast.html',
  styleUrl: './toast.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Toast {
  private readonly state = inject(MC_TOAST_STATE);

  /** The current toast; null while the pill hides. */
  protected readonly toast = this.state.toastMessage;
}
