import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { McState } from './api/state';

/**
 * The shell's toast pill (the prototype's .toast): one mono pill, bottom
 * centered above the tab bar, auto-hidden after 2.2 s. The message and
 * the timer live on McState (`toast()` — any surface can raise one), this
 * component only renders the current message and its kind tint.
 */
@Component({
  selector: 'mc-toast',
  templateUrl: './toast.html',
  styleUrl: './toast.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Toast {
  private readonly state = inject(McState);

  /** The current toast; null while the pill hides. */
  protected readonly toast = this.state.toastMessage;
}
